import { VideoItem, MAX_FADE_SECONDS, VideoAfterAction } from '../../shared/types';
import { api } from '../api';
import { modal, h, toast, confirmDialog } from '../ui';

/**
 * Модальное окно настроек видеоролика: громкость, позиции, повтор,
 * действие после завершения, следующий ролик, экран вывода,
 * Fade In / Fade Out (0–10 с), поведение при остановке.
 */
export async function openVideoSettingsModal(v: VideoItem, allVideos: VideoItem[], onSaved: () => void): Promise<void> {
  const s = await api.get<{ settings: { defaults: { fadeIn: number; fadeOut: number; volume: number; afterAction: VideoAfterAction; stopBehavior: 'black' | 'freeze' } } }>('/api/settings');
  const d = s.settings.defaults;

  modal(`Настройки: ${v.title}`, (body, close) => {
    const rows = h('div', { class: 'form-grid' });

    // Громкость
    const vol = rangeRow('Громкость ролика', 0, 1, v.volume, 0.05, (val) => String(Math.round(val * 100)) + '%');
    // Позиции
    const start = numberRow('Начальная позиция, с', v.startPosition || 0, 0);
    const end = numberRow('Конечная позиция, с (пусто — до конца)',
      v.endPosition !== undefined && v.endPosition !== null ? v.endPosition : NaN, 0);
    // Повтор
    const repeat = checkboxRow('Повторять этот ролик', v.repeat);
    // Fades
    const fadeIn = rangeRow(`Fade In (0–${MAX_FADE_SECONDS} с)`, 0, MAX_FADE_SECONDS, v.fadeIn ?? d.fadeIn, 0.5,
      (val) => val === 0 ? 'мгновенно' : val.toFixed(1) + ' с');
    const fadeOut = rangeRow(`Fade Out (0–${MAX_FADE_SECONDS} с)`, 0, MAX_FADE_SECONDS, v.fadeOut ?? d.fadeOut, 0.5,
      (val) => val === 0 ? 'мгновенно' : val.toFixed(1) + ' с');
    // Действие после завершения
    const after = selectRow('Действие после завершения', [
      ['stop', 'Стоп (чёрный экран)'],
      ['black', 'Плавно затемнить (Fade Out → чёрный)'],
      ['next', 'Следующий ролик'],
      ['loop', 'Зациклить плейлист']
    ], v.afterAction || d.afterAction);
    // Поведение при остановке
    const stopB = selectRow('Поведение при остановке', [
      ['black', 'Чёрный экран'],
      ['freeze', 'Стоп-кадр']
    ], v.stopBehavior || d.stopBehavior);
    // Следующий ролик
    const nextVid = selectRow('Следующий ролик', [
      ['', '— не задан —'],
      ...allVideos.filter(x => x.id !== v.id).map(x => [x.id, x.title] as [string, string])
    ], v.nextVideoId || '');
    // Экран вывода
    const display = displayRow(v.displayId ?? null);

    rows.append(
      vol.row, fadeIn.row, fadeOut.row,
      start.row, end.row,
      repeat.row, after.row, stopB.row, nextVid.row, display.row);

    body.append(rows);
    body.append(h('div', { class: 'btn-row end' },
      h('button', { class: 'btn ghost', onclick: async () => {
        // Сброс к значениям по умолчанию
        await api.put(`/api/videos/${v.id}/settings`, {
          fadeIn: d.fadeIn, fadeOut: d.fadeOut, volume: d.volume,
          afterAction: d.afterAction, stopBehavior: d.stopBehavior
        });
        toast('success', 'Применены значения по умолчанию');
        close();
        onSaved();
      } }, 'Сбросить по умолчанию'),
      h('button', { class: 'btn ghost', onclick: close }, 'Отмена'),
      h('button', { class: 'btn accent', onclick: async () => {
        const endVal = end.input.value.trim();
        const patch: Record<string, unknown> = {
          volume: vol.value,
          fadeIn: fadeIn.value,
          fadeOut: fadeOut.value,
          startPosition: Number(start.input.value) || 0,
          endPosition: endVal === '' ? null : (Number(endVal) || null),
          repeat: repeat.checkbox.checked,
          afterAction: after.select.value as VideoAfterAction,
          stopBehavior: stopB.select.value as 'black' | 'freeze',
          nextVideoId: nextVid.select.value || null,
          displayId: display.value
        };
        const endPos = patch.endPosition as number | null;
        const startPos = patch.startPosition as number;
        if (endPos !== null && endPos !== undefined && endPos <= startPos) {
          toast('error', 'Конечная позиция должна быть больше начальной');
          return;
        }
        try {
          await api.put(`/api/videos/${v.id}/settings`, patch);
          toast('success', 'Настройки ролика сохранены');
          close();
          onSaved();
        } catch (e) {
          toast('error', (e as Error).message);
        }
      } }, 'Сохранить')));
    void confirmDialog;
  }, { wide: true });

  // ─── Конструкторы строк формы ───

  function rangeRow(label: string, min: number, max: number, value: number, step: number, fmt: (v: number) => string) {
    let val = value;
    const labelEl = h('div', { class: 'range-value' }, fmt(val));
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
    input.addEventListener('input', () => {
      val = Number(input.value);
      labelEl.textContent = fmt(val);
    });
    return {
      get value(): number { return val; },
      row: h('div', { class: 'form-row' },
        h('label', { class: 'form-label' }, label, labelEl), input)
    };
  }

  function numberRow(label: string, value: number, min: number) {
    const input = h('input', { class: 'input', type: 'number', step: '0.1', min: String(min),
      value: isFinite(value) ? String(value) : '' }) as HTMLInputElement;
    return { input, row: h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, label), input) };
  }

  function checkboxRow(label: string, checked: boolean) {
    const checkbox = h('input', { type: 'checkbox', checked: checked ? '' : undefined }) as HTMLInputElement;
    return { checkbox, row: h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, label), checkbox) };
  }

  function selectRow(label: string, options: [string, string][], value: string) {
    const select = h('select', { class: 'input select' },
      ...options.map(([val, lab]) => h('option', { value: val, selected: val === value ? '' : undefined }, lab))) as HTMLSelectElement;
    return { select, row: h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, label), select) };
  }

  function displayRow(current: number | null) {
    const select = h('select', { class: 'input select' },
      h('option', { value: '', selected: current === null ? '' : undefined }, '— как в настройках сцены —')) as HTMLSelectElement;
    let value: number | null = current;
    void api.get<{ displays: { id: number; label: string }[] }>('/api/displays').then(r => {
      for (const dsiplay of r.displays) {
        select.append(h('option', { value: String(dsiplay.id), selected: dsiplay.id === current ? '' : undefined }, dsiplay.label));
      }
    }).catch(() => { /* дисплеи недоступны без Electron */ });
    select.addEventListener('change', () => {
      value = select.value === '' ? null : Number(select.value);
    });
    return { get value(): number | null { return value; }, row: h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, 'Экран вывода'), select) };
  }
}
