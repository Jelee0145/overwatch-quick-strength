// ICP filing mark required at the bottom of every public page of the site.
export const ICP_NUMBER = '粤ICP备2026115554号';
const MARK = 'data-icp-footer';
const STYLE =
  'body>footer.icp-footer{display:block;position:static;width:auto;max-width:none;margin:0;padding:14px 16px calc(14px + env(safe-area-inset-bottom));border:0;background:none;text-align:center;font:12px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}' +
  'body>footer.icp-footer a{display:inline;color:inherit;opacity:.62;text-decoration:none}body>footer.icp-footer a:hover,body>footer.icp-footer a:focus-visible{opacity:1;text-decoration:underline}';

export function withIcp(page) {
  if (page.includes(MARK)) return page;
  if (!page.includes('</body>')) throw Error('Page has no </body> to attach the ICP footer to');
  const footer =
    `<style>${STYLE}</style>` +
    `<footer class="icp-footer" ${MARK}><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${ICP_NUMBER}</a></footer>`;
  const at = page.lastIndexOf('</body>');
  return page.slice(0, at) + footer + page.slice(at);
}
