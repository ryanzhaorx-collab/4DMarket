/**
 * 可视化调参面板（?tune=1 打开）。
 * 所有数值集中在这里，改完即时生效；点「复制配置」把当前参数吐出来，
 * 贴给我就能写死进代码。
 */
export type TuneParams = {
  /** 分层展开：每层错开多少米 */
  unfoldSpread: number;
  /** 分层展开时长（毫秒） */
  unfoldDuration: number;
  /** 抽屉：沿视线平推距离（米） */
  pushDistance: number;
  /** 抽屉：平推时长（毫秒） */
  pushDuration: number;
  /** 抽屉：起始高度偏移（米，正数向上） */
  pushStartY: number;
  /** 显影：扫过时长（毫秒） */
  developDuration: number;
  /** 主机位：距离 */
  camDistance: number;
  /** 主机位：水平角 */
  camYaw: number;
  /** 主机位：俯仰角 */
  camPitch: number;
};

export const DEFAULT_TUNE: TuneParams = {
  unfoldSpread: 16,
  unfoldDuration: 1800,
  pushDistance: 92,
  pushDuration: 2400,
  pushStartY: 8,
  developDuration: 4200,
  camDistance: 590,
  camYaw: 0.98,
  camPitch: 0.2,
};

const KEY = 'dsh.tune.v1';

export function loadTune(): TuneParams {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_TUNE, ...(JSON.parse(raw) as Partial<TuneParams>) };
  } catch {
    /* 忽略 */
  }
  return { ...DEFAULT_TUNE };
}

function saveTune(p: TuneParams) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 忽略 */
  }
}

type Field = { key: keyof TuneParams; label: string; min: number; max: number; step: number; unit?: string };

const FIELDS: Field[] = [
  { key: 'unfoldSpread', label: '分层间距', min: 0, max: 120, step: 1, unit: 'm' },
  { key: 'unfoldDuration', label: '分层时长', min: 400, max: 4000, step: 100, unit: 'ms' },
  { key: 'pushDistance', label: '抽屉推出距离', min: 0, max: 220, step: 2, unit: 'm' },
  { key: 'pushDuration', label: '抽屉时长', min: 400, max: 6000, step: 100, unit: 'ms' },
  { key: 'pushStartY', label: '抽屉起始高度', min: -40, max: 60, step: 1, unit: 'm' },
  { key: 'developDuration', label: '入场显影时长', min: 800, max: 8000, step: 200, unit: 'ms' },
  { key: 'camDistance', label: '主机位距离', min: 200, max: 1200, step: 10, unit: 'm' },
  { key: 'camYaw', label: '主机位水平角', min: -1.6, max: 1.6, step: 0.02 },
  { key: 'camPitch', label: '主机位俯仰', min: -0.2, max: 1.2, step: 0.01 },
];

/** 挂载调参面板，返回当前参数对象（外部随时读取） */
export function mountTune(initial: TuneParams, onReplay: () => void): TuneParams {
  const p = { ...initial };
  const host = document.createElement('div');
  host.className = 'tune';
  host.innerHTML = `
    <div class="tune-head">
      <b>动画调参</b>
      <button data-act="replay">重播</button>
      <button data-act="copy">复制配置</button>
      <button data-act="close">×</button>
    </div>
    <div class="tune-body"></div>
    <pre class="tune-out"></pre>
  `;
  document.body.appendChild(host);

  const body = host.querySelector('.tune-body')!;
  const out = host.querySelector('.tune-out') as HTMLElement;

  for (const f of FIELDS) {
    const row = document.createElement('label');
    row.className = 'tune-row';
    row.innerHTML = `
      <span>${f.label}</span>
      <input type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${p[f.key]}" />
      <em>${p[f.key]}${f.unit ?? ''}</em>
    `;
    const input = row.querySelector('input')!;
    const em = row.querySelector('em')!;
    input.addEventListener('input', () => {
      p[f.key] = Number(input.value);
      em.textContent = `${p[f.key]}${f.unit ?? ''}`;
      saveTune(p);
    });
    body.appendChild(row);
  }

  host.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).dataset.act;
    if (act === 'replay') onReplay();
    if (act === 'copy') {
      const json = JSON.stringify(p, null, 2);
      out.textContent = json;
      void navigator.clipboard?.writeText(json).catch(() => {});
    }
    if (act === 'close') host.remove();
  });

  return p;
}
