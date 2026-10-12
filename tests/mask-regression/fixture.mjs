// Creates a throwaway lesson on the local server with points engineered for the
// masking audit. Delete it with del.mjs when done.
export const FIXTURE_PREFIX = 'zz-mask-audit-';
export function fixtureLesson(id) {
  const P = (title, explanation, extra = {}) => ({
    title, category: ['遮字测试'], explanation, importance: 'high',
    mnemonic: '', tags: ['mask-audit'], keyTerms: [], slide: null,
    feynmanStage: 1, feynmanDue: 1, feynmanLast: 1, feynmanCount: 1, feynmanReps: 1, feynmanLapses: 0,
    ...extra,
  });
  return {
    id,
    title: 'ZZ MASK AUDIT FIXTURE (auto-deleted)',
    filename: 'mask-audit.txt',
    kind: 'text',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    slides: [],
    outline: [],
    points: [
      // 0: same word 3x in ONE paragraph + a keyTerm to exercise highlight overlap
      P('重复词三处', '- 地高辛抑制 Na+/K+-ATPase 转运。地高辛的治疗窗很窄。监测地高辛血药浓度非常重要。', { keyTerms: ['治疗窗'] }),
      // 1: markdown elements + formula
      P('跨元素选区', '- **粗体开头**与*斜体中间*还有`inline code`结尾。公式 \\(K_d\\) 混在中间。', { en: { title: 'Cross elements', explanation: '- **Bold** and *italic* and `code` around a formula \\(K_d\\) here.' } }),
      // 2: two paragraphs
      P('跨段落选区', '- 第一段落结束时留下接力词甲。\n- 接力词乙紧接着第二段落继续写下去。'),
      // 3: punctuation / english / digits
      P('标点英文数字', '- 用法：0.125 mg/d，即 digoxin 0.25mg，中文English混排（2026）。', { en: { title: 'Punctuation', explanation: '- Dose 0.125 mg/d of digoxin.' } }),
      // 4: long paragraph spanning several lines when rendered
      P('长段落', '- 这是一个很长的段落，用来测试跨行选区是否会被截断。' + '肾上腺素能受体广泛分布于心血管系统，激动后通过 G 蛋白偶联通路产生正性肌力与正性频率作用。'.repeat(3)),
      // 5: legacy bare-string mask
      P('旧格式裸字符串', '- 旧数据里存的是裸字符串片段，这一段里片段两个字出现了两次：片段甲和片段乙。', { masks: ['片段'] }),
      // 6: masks that no longer match the explanation
      P('失配遮字', '- 这一段已经被重新生成过了，原来的遮字片段早已不存在。', { masks: [{ t: '早已不存在', n: 0 }, { t: '完全不存在XYZ', n: 0 }] }),
      // 7: mixed / out-of-order n
      P('乱序n', '- 丙一，丙二，丙三，丙四。', { masks: [{ t: '丙', n: 3 }, { t: '丙', n: 1 }] }),
      // 8: empty selection target
      P('空白选区', '- 空选区测试段落，选中后立刻点空白处不应该产生遮字。'),
      // 9: two key terms, for the active-recall interaction
      P('回忆两个术语', '- 甲术语说明第一步，乙术语说明第二步。', { keyTerms: ['甲术语', '乙术语'] }),
    ],
  };
}
export async function createFixture(base, id) {
  const r = await fetch(base + '/api/store/lessons/' + id, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixtureLesson(id)),
  });
  if (!r.ok) throw new Error('fixture PUT ' + r.status + ' ' + (await r.text()));
  return fixtureLesson(id);
}
export async function deleteFixture(base, id) {
  const r = await fetch(base + '/api/store/lessons/' + id, { method: 'DELETE' });
  return r.status;
}
