const KEY = 'patreon-dl:transcribe-with-translation';

/**
 * Whether the "also translate" box on a transcribe confirmation starts ticked.
 *
 * Remembered in the browser rather than on the server: it is a habit, not a
 * setting, and an administrator who works through a library of videos should
 * not have to tick the same box on each of them. It starts ticked because
 * someone who has configured a Gemini key configured it in order to use it -
 * unticking it once is enough to stop being asked.
 */
export function readTranslatePreference() {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === null ? true : stored === 'true';
  }
  catch {
    // Private mode, or storage switched off. The default is the right answer
    // and the preference simply does not persist.
    return true;
  }
}

export function writeTranslatePreference(value: boolean) {
  try {
    window.localStorage.setItem(KEY, String(value));
  }
  catch {
    // Nothing to do: the choice still applies to this dialog.
  }
}
