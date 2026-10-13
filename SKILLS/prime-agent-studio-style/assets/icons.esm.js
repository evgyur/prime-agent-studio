// ES module entry of the Studio icons, for apps and bundlers (same API as icons.js).
// import { ICONS, iconSvg, mountIcons, MARK_PATH, markSvg } from './icons.esm.js';
import './icons.js';

export const { ICONS, iconSvg, mountIcons, MARK_PATH, markSvg } = globalThis.StudioIcons;
