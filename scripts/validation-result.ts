/** 部分実行や対象ゼロを翻訳検証の成功と誤表示しない。 */
export function validationResult(requested: number, states: Array<{status: string}>) {
  const translated = states.filter(state => state.status === 'translated').length;
  const failed = states.filter(state => state.status === 'error').length;
  const pending = Math.max(0, requested - translated - failed);
  return {requested, translated, failed, pending,
    exitCode: requested > 0 && translated === requested && failed === 0 ? 0 : 3};
}
