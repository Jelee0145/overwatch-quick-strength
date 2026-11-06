import test from 'node:test';
import assert from 'node:assert/strict';
import { ICP_NUMBER, withIcp } from '../../scripts/build/icp.mjs';

test('ICP filing number is linked to the MIIT site at the end of the page', () => {
  const page = withIcp('<html><body><main>content</main>\n<dialog></dialog></body></html>');
  assert.match(
    page,
    new RegExp(
      `<a href="https://beian\.miit\.gov\.cn/" target="_blank" rel="noopener noreferrer">${ICP_NUMBER}</a></footer></body></html>$`
    )
  );
  assert.equal(ICP_NUMBER, '粤ICP备2026115554号');
});

test('the footer is added once and never to a page without a body', () => {
  const once = withIcp('<body></body>');
  assert.equal(withIcp(once), once);
  assert.throws(() => withIcp('<div></div>'), /no <\/body>/);
});
