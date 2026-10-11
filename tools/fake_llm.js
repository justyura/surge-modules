// 测试用的假大模型（OpenAI Chat Completions 接口）：把要翻的每一段前面加上「模:」。
// 要翻的段落在 texts、lines 或 comments 字段里（编号 → 原文），其他字段是上下文。
//
// llm = {
//   status: 200 | 状态码 | 'hang'（永不返回）
//   latency: 毫秒
//   drop: 漏掉的编号
//   wrap: true（回复多包一层 { translations: … }）
//   error: 出错时的 body
// }
// 不是发给大模型的请求返回 false，交给调用方处理
module.exports = function fakeLlm(req, cb, calls, llm = {}) {
  if (!req.url.endsWith('/chat/completions')) return false;
  const b = JSON.parse(req.body);
  const payload = JSON.parse(b.messages[1].content);
  const field = ['texts', 'lines', 'comments'].find((f) => payload[f]);
  calls.push({
    vendor: 'llm', url: req.url, key: req.headers.Authorization.replace('Bearer ', ''), model: b.model, effort: b.reasoning_effort,
    format: b.response_format.type, system: b.messages[0].content, payload, n: Object.keys(payload[field]).length,
  });
  const status = llm.status ?? 200;
  if (status === 'hang') return true;
  setTimeout(() => {
    if (status !== 200) return cb(null, { status }, llm.error || '{"error":{"message":"err"}}');
    let out = {};
    for (const [k, v] of Object.entries(payload[field])) if (k !== String(llm.drop)) out[k] = '模:' + v;
    if (llm.wrap) out = { translations: out };
    cb(null, { status: 200 }, JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
  }, llm.latency || 0);
  return true;
};
