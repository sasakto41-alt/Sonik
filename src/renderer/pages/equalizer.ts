import { h, clear, el, toast, promptDialog, confirmDialog } from '../ui';
import { icon } from '../icons';
import { api, isElectron } from '../api';
import { EQ_BANDS, EQ_PRESETS, EqState } from '../../shared/types';
import { snapshotListener } from '../components';

/**
 * Эквалайзер: 10 полос, пресеты, пользовательские пресеты, вкл/выкл.
 * Изменения отправляются на сервер и реально применяются в desktop-плеере.
 */
export function mountEqualizer(container: HTMLElement): { teardown: () => void } {
  clear(container);
  const wrap = h('div', { class: 'page-wrap' });
  container.append(wrap);

  let eq: EqState = { enabled: false, preset: 'Flat', gains: EQ_BANDS.map(() => 0), customPresets: [] };
  let dragging = false;

  async function load(): Promise<void> {
    try {
      eq = (await api.get<{ eq: EqState }>('/api/equalizer')).eq;
    } catch { /* тост из api */ }
    render();
  }

  async function push(): Promise<void> {
    try {
      await api.put('/api/equalizer', eq);
    } catch (e) { toast('error', (e as Error).message); }
    render();
  }

  function render(): void {
    clear(wrap);
    const head = h('div', { class: 'page-head' },
      h('h2', { class: 'page-title' }, 'Эквалайзер'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn' + (eq.enabled ? ' accent' : ''), onclick: () => { eq.enabled = !eq.enabled; void push(); } },
          eq.enabled ? 'Обработка включена' : 'Обработка выключена'),
        h('button', { class: 'btn ghost', onclick: () => { eq.gains = EQ_BANDS.map(() => 0); eq.preset = 'Flat'; void push(); } }, 'Сброс')));
    wrap.append(head);

    if (!isElectron()) {
      wrap.append(h('div', { class: 'note-card' }, 'Эквалайзер применяется к звуку на компьютере. Изменения с телефона действуют на десктопное воспроизведение.'));
    }

    // Пресеты
    const presetRow = h('div', { class: 'btn-row wrap' });
    for (const name of Object.keys(EQ_PRESETS)) {
      presetRow.append(h('button', { class: 'btn ghost small' + (eq.preset === name ? ' active' : ''),
        onclick: () => { eq.preset = name; eq.gains = [...EQ_PRESETS[name]]; void push(); } }, name));
    }
    for (const cp of eq.customPresets) {
      presetRow.append(h('button', { class: 'btn ghost small' + (eq.preset === cp.name ? ' active' : ''),
        onclick: () => { eq.preset = cp.name; eq.gains = [...cp.gains]; void push(); },
        oncontextmenu: (e) => { e.preventDefault(); void deletePreset(cp.name); } }, cp.name + ' ✕?'));
    }
    presetRow.append(h('button', { class: 'btn small', html: icon('plus') + '<span>Сохранить пресет</span>', onclick: () => void savePreset() }));
    wrap.append(presetRow);

    // Полосы
    const bandsRow = h('div', { class: 'eq-bands' });
    EQ_BANDS.forEach((freq, i) => {
      const gain = eq.gains[i] || 0;
      const label = freq >= 1000 ? (freq / 1000) + 'к' : String(freq);
      const value = h('span', { class: 'eq-value' }, (gain > 0 ? '+' : '') + gain.toFixed(0) + ' дБ');
      const input = h('input', { type: 'range', min: '-12', max: '12', step: '1', value: String(gain) }) as HTMLInputElement;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        eq.gains[i] = v;
        eq.preset = 'custom';
        value.textContent = (v > 0 ? '+' : '') + v.toFixed(0) + ' дБ';
        input.classList.toggle('pos', v > 0);
        input.classList.toggle('neg', v < 0);
      });
      input.addEventListener('change', () => { void push(); });
      input.classList.toggle('pos', gain > 0);
      input.classList.toggle('neg', gain < 0);
      bandsRow.append(h('div', { class: 'eq-band' + (eq.enabled ? '' : ' disabled') },
        value, input, h('span', { class: 'eq-freq' }, label)));
    });
    wrap.append(bandsRow);

    // Двойной клик по полосе — сброс полосы
    bandsRow.querySelectorAll('.eq-band input').forEach((input, i) => {
      input.addEventListener('dblclick', () => {
        eq.gains[i] = 0;
        void push();
      });
    });
    void dragging;
  }

  async function savePreset(): Promise<void> {
    const name = await promptDialog('Сохранить пресет', 'Название пресета');
    if (!name) return;
    eq.customPresets = [...eq.customPresets.filter(p => p.name !== name), { name, gains: [...eq.gains] }];
    eq.preset = name;
    await push();
    toast('success', `Пресет «${name}» сохранён`);
  }

  async function deletePreset(name: string): Promise<void> {
    const ok = await confirmDialog('Удалить пресет', `Удалить пользовательский пресет «${name}»?`, 'Удалить', true);
    if (!ok) return;
    eq.customPresets = eq.customPresets.filter(p => p.name !== name);
    if (eq.preset === name) eq.preset = 'custom';
    await push();
  }

  // Внешние изменения (с телефона) — перерисовка
  const off = snapshotListener((s) => {
    if (!dragging) {
      const changed = JSON.stringify(s.eq) !== JSON.stringify(eq);
      if (changed) { eq = s.eq; render(); }
    }
  });

  window.addEventListener('pointerdown', () => { dragging = false; }, { once: true });
  void el;

  void load();
  return { teardown: off };
}
