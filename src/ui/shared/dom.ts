// UI lookups return `any`: the elements are known from the page's own HTML, not checked here.
export const $ = (sel: string): any => document.querySelector(sel);
