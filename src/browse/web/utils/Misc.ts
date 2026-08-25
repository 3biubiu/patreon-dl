import type { Campaign, Post, Product } from "../../../entities";
import { ProductType } from "../../../entities/Product";

export function getCampaignBaseUrl(campaign: Campaign) {
  return campaign.creator?.vanity ?
    `/${encodeURIComponent(campaign.creator.vanity)}` :
    `/campaigns/${campaign.id}`;
}

export function getContentUrl(entity: Post | Product) {
  let domain, referenceId;
  switch (entity.type) {
    case 'post':
      domain = 'posts';
      referenceId = entity.id;
      break;
    case 'product': {
      if (entity.productType === ProductType.Post) {
        domain = 'posts';
        referenceId = entity.referencedEntityId;
      }
      else if (entity.productType === ProductType.Collection) {
        domain = 'collections';
        referenceId = entity.referencedEntityId;
      }
      else {
        domain = 'products';
        referenceId = entity.id;
      }
      break;
    }
  } 
  const originalFilename = entity.url ? entity.url.split('/').pop() : null;
  // Check if the url ends with <slug>-<id>
  if (originalFilename && originalFilename.split('-').pop() === referenceId) {
    return `/${domain}/${originalFilename}`;
  }
  return `/${domain}/${referenceId}`;
}
const FILE_ICONS: Record<string, string> = {
  pdf: 'picture_as_pdf',
  zip: 'folder_zip', rar: 'folder_zip', '7z': 'folder_zip', tar: 'folder_zip',
  gz: 'folder_zip', bz2: 'folder_zip', xz: 'folder_zip',
  stl: 'view_in_ar', obj: 'view_in_ar', '3mf': 'view_in_ar', fbx: 'view_in_ar',
  blend: 'view_in_ar', step: 'view_in_ar', stp: 'view_in_ar', gltf: 'view_in_ar',
  glb: 'view_in_ar', lys: 'view_in_ar', chitubox: 'view_in_ar',
  doc: 'description', docx: 'description', txt: 'description', rtf: 'description',
  md: 'description', odt: 'description', epub: 'menu_book',
  xls: 'table_chart', xlsx: 'table_chart', csv: 'table_chart', ods: 'table_chart',
  ppt: 'slideshow', pptx: 'slideshow', odp: 'slideshow',
  psd: 'brush', ai: 'brush', eps: 'brush', svg: 'brush', xcf: 'brush',
  clip: 'brush', kra: 'brush', procreate: 'brush',
  ttf: 'font_download', otf: 'font_download', woff: 'font_download', woff2: 'font_download',
  exe: 'terminal', msi: 'terminal', dmg: 'terminal', apk: 'terminal',
  json: 'data_object', xml: 'data_object'
};

export function getFileExtension(filename: string | null) {
  if (!filename) {
    return '';
  }
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return '';
  }
  return filename.slice(dotIndex + 1).toLowerCase();
}

export function getFileIcon(filename: string | null) {
  return FILE_ICONS[getFileExtension(filename)] || 'insert_drive_file';
}

export function formatFileSize(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = [ 'KB', 'MB', 'GB', 'TB' ];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * URL of a post / product page, with `mediaId` marked so the page can scroll to
 * and highlight the media item the visitor came from.
 */
export function getContentUrlForMedia(entity: Post | Product, mediaId: string) {
  const url = new URL(getContentUrl(entity), window.location.href);
  url.searchParams.set('media', mediaId);
  return `${url.pathname}${url.search}`;
}
