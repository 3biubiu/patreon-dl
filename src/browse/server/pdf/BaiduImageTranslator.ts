import crypto from 'crypto';
// `FormData` comes from undici too, and deliberately: this project's fetch is
// undici's own rather than the one built into Node, and the two ship separate
// copies of the class. A form built from the global one fails undici's brand
// check, whereupon it is sent as the string "[object FormData]" with a
// text/plain content type - a request Baidu can only refuse, and one that
// looks perfectly well formed from this side.
import { fetch, FormData } from 'undici';
import { commonLog } from '../../../utils/logging/Logger.js';
import type Logger from '../../../utils/logging/Logger.js';
import { dispatcherFor } from './Proxy.js';

/**
 * Translating a page as a picture, through Baidu's image translation API.
 *
 * The text engines beside this one are given words and hand words back; this
 * one is given the page as it was drawn and hands back the same page with the
 * translation printed into it, in place of the words it replaced. That is the
 * only thing that helps with the pages the text engines cannot touch at all -
 * a scan, a comic, a diagram whose labels are part of the artwork - because
 * there is no text layer in those to extract, lay out, or lay anything over.
 *
 * Baidu is the only provider here rather than one of a list: it is configured
 * by credentials, not chosen, and choosing an engine above has no effect on
 * it. The two features share the proxy and the target language and nothing
 * else.
 *
 * @see https://fanyi-api.baidu.com/doc/24
 */

const ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/sdk/picture';

/** Both are fixed values the API requires; neither identifies anything. */
const CUID = 'APICUID';
const MAC = 'mac';
const VERSION = '3';

/**
 * "Paste the translation into the whole picture", which is what makes the
 * reply a page rather than a list of strings with coordinates. `data.pasteImg`
 * only comes back with this set.
 */
const PASTE_WHOLE_IMAGE = '1';

/** The API's own limits, checked here so a refusal is ours rather than theirs. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MIN_SHORT_EDGE = 30;
const MAX_LONG_EDGE = 4096;
const MAX_ASPECT_RATIO = 3;

const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Baidu's language codes, which are its own: two letters for some, three for
 * others, and traditional Chinese is a language rather than a region. Anything
 * not listed is passed through lower-cased, which is right for the plain
 * two-letter codes it shares with everyone else.
 */
const LANGUAGE_MAP: Record<string, string> = {
  'zh': 'zh',
  'zh-cn': 'zh',
  'zh-hans': 'zh',
  'zh-tw': 'cht',
  'zh-hk': 'cht',
  'zh-hant': 'cht',
  'en': 'en',
  'en-us': 'en',
  'en-gb': 'en',
  'ja': 'jp',
  'ja-jp': 'jp',
  'ko': 'kor',
  'ko-kr': 'kor',
  'fr': 'fra',
  'es': 'spa',
  'ar': 'ara',
  'bg': 'bul',
  'et': 'est',
  'da': 'dan',
  'fi': 'fin',
  'ro': 'rom',
  'sk': 'slo',
  'sv': 'swe',
  'vi': 'vie',
  'zh-yue': 'yue'
};

export function toBaiduLanguage(language: string) {
  return LANGUAGE_MAP[language.toLowerCase()] || language.toLowerCase();
}

/**
 * What Baidu answers with when something is wrong, said plainly.
 *
 * Its `error_msg` is terse and sometimes English, sometimes not; these are the
 * ones an administrator can actually do something about, and everything else
 * falls through to whatever it said.
 */
const ERROR_MESSAGES: Record<string, string> = {
  '52001': 'Baidu timed out - try that page again',
  '52002': 'Baidu had an internal error',
  '52003': 'Baidu did not recognise that APP ID',
  '54000': 'A required parameter was missing',
  '54001': 'Baidu refused the signature - check the secret key',
  '54003': 'Too many requests for this account just now',
  '54004': 'This Baidu account is out of balance',
  '54005': 'Too many long requests just now',
  '58000': 'Baidu refused this server\'s IP address - check the allow list on the console',
  '58001': 'Baidu does not translate between those two languages',
  '58002': 'Image translation is switched off for this Baidu account',
  '90107': 'This Baidu account has not been verified for the image translation API',
  '24003': 'That page image is not one Baidu will accept'
};

export interface BaiduImageTranslatorSettings {
  appId: string | null;
  secretKey: string | null;
  /** `null` goes direct, which is what an empty setting means. */
  proxyUrl: string | null;
  targetLanguage: string;
}

export class BaiduNotConfiguredError extends Error {
  constructor() {
    super('Image translation needs a Baidu APP ID and secret key');
    this.name = 'BaiduNotConfiguredError';
  }
}

/** An image Baidu would refuse, refused here instead - with the reason. */
export class UnusableImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnusableImageError';
  }
}

export interface TranslatedImage {
  /** The page with the translation printed into it. */
  image: Buffer;
  contentType: string;
  from: string;
  to: string;
}

/**
 * Enough of a PNG or JPEG header to get the size out.
 *
 * Only so that a page Baidu would reject is refused before it is uploaded,
 * with a reason that names the limit rather than an error code. Anything that
 * cannot be read here is passed on unchecked - Baidu is the authority, this is
 * only the courtesy.
 */
function readImageSize(image: Buffer): { width: number; height: number } | null {
  if (image.length > 24 && image.readUInt32BE(0) === 0x89504e47) {
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  }
  if (image.length > 4 && image[0] === 0xff && image[1] === 0xd8) {
    let at = 2;
    while (at + 9 < image.length) {
      if (image[at] !== 0xff) {
        at++;
        continue;
      }
      const marker = image[at + 1];
      // The frame headers, which are the ones carrying the dimensions. The
      // rest are skipped by their own declared length.
      if (marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: image.readUInt16BE(at + 5), width: image.readUInt16BE(at + 7) };
      }
      at += 2 + image.readUInt16BE(at + 2);
    }
  }
  return null;
}

/** PNG or JPEG, read from the bytes rather than trusted from the request. */
export function imageContentType(image: Buffer) {
  if (image.length > 8 && image.readUInt32BE(0) === 0x89504e47) {
    return 'image/png';
  }
  if (image.length > 3 && image[0] === 0xff && image[1] === 0xd8) {
    return 'image/jpeg';
  }
  return null;
}

export default class BaiduImageTranslator {
  name = 'BaiduImageTranslator';

  #getSettings: () => BaiduImageTranslatorSettings;
  #logger?: Logger | null;

  constructor(getSettings: () => BaiduImageTranslatorSettings, logger?: Logger | null) {
    this.#getSettings = getSettings;
    this.#logger = logger;
  }

  get targetLanguage() {
    return this.#getSettings().targetLanguage;
  }

  /** Both halves or neither: an APP ID without its key signs nothing. */
  get configured() {
    const { appId, secretKey } = this.#getSettings();
    return !!appId?.trim() && !!secretKey?.trim();
  }

  protected log(level: Parameters<typeof commonLog>[1], ...msg: any[]) {
    commonLog(this.#logger, level, this.name, ...msg);
  }

  /**
   * Checks a page image against the limits Baidu publishes.
   *
   * Doing it here turns "24003" into a sentence that says which limit was
   * missed, and saves uploading four megabytes to be told so.
   */
  #check(image: Buffer) {
    if (image.length > MAX_IMAGE_BYTES) {
      throw new UnusableImageError('That page image is larger than the 4 MB Baidu accepts');
    }
    if (!imageContentType(image)) {
      throw new UnusableImageError('Baidu accepts JPEG and PNG page images only');
    }
    const size = readImageSize(image);
    if (!size || !size.width || !size.height) {
      return;
    }
    const short = Math.min(size.width, size.height);
    const long = Math.max(size.width, size.height);
    if (short < MIN_SHORT_EDGE) {
      throw new UnusableImageError('That page is too small for Baidu to read');
    }
    if (long > MAX_LONG_EDGE) {
      throw new UnusableImageError('That page is larger than the 4096 pixels Baidu accepts');
    }
    if (long / short > MAX_ASPECT_RATIO) {
      throw new UnusableImageError('That page is too long and thin for Baidu to accept');
    }
  }

  /**
   * The page, translated into a picture of itself.
   *
   * `null` where Baidu found nothing to translate - a page of photographs, a
   * blank one - which is not a failure and is worth telling apart from one, so
   * that the reader can say so and stop asking.
   */
  async translateImage(
    image: Buffer, to?: string | null, from?: string | null, signal?: AbortSignal
  ): Promise<TranslatedImage | null> {
    const settings = this.#getSettings();
    const appId = settings.appId?.trim();
    const secretKey = settings.secretKey?.trim();
    if (!appId || !secretKey) {
      throw new BaiduNotConfiguredError();
    }
    this.#check(image);

    const target = toBaiduLanguage(to || settings.targetLanguage);
    // "auto": a PDF is as likely to be in one language as another, and Baidu
    // detects it from the picture better than we could guess it from the file.
    const source = from ? toBaiduLanguage(from) : 'auto';
    const salt = String(Date.now());
    // md5(appid + md5(image) + salt + cuid + mac + secret), which is what the
    // API documents. The inner hash is over the raw bytes, not over any
    // encoding of them.
    const imageHash = crypto.createHash('md5').update(image).digest('hex');
    const sign = crypto.createHash('md5')
      .update(`${appId}${imageHash}${salt}${CUID}${MAC}${secretKey}`)
      .digest('hex');

    const form = new FormData();
    form.append('image', new Blob([ new Uint8Array(image) ], {
      type: imageContentType(image) || 'image/jpeg'
    }), 'page.jpg');
    form.append('from', source);
    form.append('to', target);
    form.append('appid', appId);
    form.append('salt', salt);
    form.append('sign', sign);
    form.append('cuid', CUID);
    form.append('mac', MAC);
    form.append('version', VERSION);
    form.append('paste', PASTE_WHOLE_IMAGE);

    this.log('debug',
      `Translating a page image into ${target} ` +
      `(${(image.length / 1024).toFixed(0)} kB${settings.proxyUrl ? `, through ${settings.proxyUrl}` : ''})`
    );

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      body: form,
      dispatcher: dispatcherFor(settings.proxyUrl, this.name, this.#logger),
      signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    } as any);
    if (!response.ok) {
      throw new Error(`Baidu answered ${response.status} ${response.statusText}`.trim());
    }

    const body = await response.json() as {
      error_code?: string | number;
      error_msg?: string;
      data?: {
        from?: string;
        to?: string;
        pasteImg?: string;
        content?: unknown[];
      };
    };
    // Answered as a string in the documentation and as a number in practice,
    // depending on the account; "0" and 0 both mean it worked.
    const code = body.error_code === undefined || body.error_code === null ?
      '0' : String(body.error_code);
    if (code !== '0') {
      throw new Error(
        ERROR_MESSAGES[code] || body.error_msg || `Baidu refused the page (error ${code})`
      );
    }
    const pasted = body.data?.pasteImg;
    if (!pasted) {
      // Either there was no text on the page or Baidu found none it could
      // read. Both mean the same thing to the reader.
      return null;
    }
    const translated = Buffer.from(pasted, 'base64');
    const contentType = imageContentType(translated);
    if (!translated.length || !contentType) {
      throw new Error('Baidu returned a page image that could not be read');
    }
    return {
      image: translated,
      contentType,
      from: body.data?.from || source,
      to: body.data?.to || target
    };
  }
}
