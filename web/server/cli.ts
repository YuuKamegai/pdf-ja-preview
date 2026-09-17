/** `npm run start:web` の入口。main() を呼ぶだけ。 */

import { main } from './main';

void main().then((code) => {
  if (code !== 0) process.exit(code);
});
