/**
 * 抽出ワーカーの身代わり。契約（stdout に JSON 一件、ログは stderr）だけを真似る。
 *
 *   node fake-worker.mjs --mode <mode> [--input <path>] [--hash <sha>] ...
 *
 * mode:
 *   ok       正しい文書を返す
 *   error    ワーカー側の失敗を返す
 *   broken   JSON でない出力
 *   silent   何も出さずに終わる
 *   huge     上限を超える出力を延々と出す
 *   slow     `--delay` ミリ秒待ってから ok を返す（取り消し・タイムアウト用）
 *   noisy    stdout の前後にログを混ぜる
 *   invalid  JSON だが中間形式の契約に反する
 *   spin     終わらない。殺されるまで回る
 */

const argv = process.argv.slice(2);

function option(name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

const mode = option('--mode', 'ok');
const hash = option('--hash', 'a'.repeat(64));
const delay = Number(option('--delay', '0'));

function document(pages = 1) {
  return {
    schema: 'pdf-document.v1',
    hash,
    extractor: { version: 'fake', configHash: 'b'.repeat(64) },
    pages: Array.from({ length: pages }, (_, index) => ({
      number: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      status: 'ok',
    })),
    blocks: [
      {
        id: 'b0',
        kind: 'paragraph',
        order: 0,
        source: 'Hello from the fake worker.',
        headingContext: '',
        translatable: true,
        regions: [{ page: 1, box: [0.1, 0.1, 0.9, 0.2] }],
        relatedIds: [],
      },
    ],
    warnings: [],
  };
}

function emitOk() {
  process.stdout.write(JSON.stringify({ ok: true, document: document() }) + '\n');
}

switch (mode) {
  case 'error':
    process.stderr.write('worker log line\n');
    process.stdout.write(
      JSON.stringify({ ok: false, error: { code: 'encrypted-pdf', message: '暗号化された PDF' } }) +
        '\n',
    );
    process.exit(1);
    break;

  case 'broken':
    process.stdout.write('Loading weights: 100%\nnot json at all\n');
    break;

  case 'silent':
    process.stderr.write('nothing to say\n');
    process.exit(3);
    break;

  case 'invalid':
    process.stdout.write(
      JSON.stringify({ ok: true, document: { ...document(), schema: 'pdf-document.v9' } }) + '\n',
    );
    break;

  case 'noisy':
    process.stderr.write('progress 1\n');
    emitOk();
    process.stderr.write('progress 2\n');
    break;

  case 'huge': {
    const chunk = 'x'.repeat(1024 * 1024);
    const write = () => {
      // 背圧を見ながら出し続ける。監督側が上限で殺すはず。
      while (process.stdout.write(chunk)) {
        /* 書けるだけ書く */
      }
    };
    process.stdout.on('drain', write);
    write();
    break;
  }

  case 'slow':
    setTimeout(emitOk, delay);
    break;

  case 'spin':
    setInterval(() => {
      process.stderr.write('still here\n');
    }, 50);
    break;

  default:
    emitOk();
}
