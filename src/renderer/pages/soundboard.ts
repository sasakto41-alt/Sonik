import { h, clear, emptyState, spinner, toast, confirmDialog, promptDialog, modal } from '../ui';
import { ICONS, icon } from '../icons';
import { api, isElectron } from '../api';
import { SoundButton, SoundSet, SoundMode } from '../../shared/types';
import { snapshotListener } from '../components';
import { localPref, setLocalPref } from '../store';

/**
 * Soundboard: наборы, кнопки с цветом/иконкой/громкостью/режимом/хоткеем,
 * drag&drop переупорядочивание, поиск, локальное воспроизведение через Web Audio.
 */
export function mountSoundboard(container: HTMLElement): { teardown: () => void } {
  clear(container);
  let config: { sets: SoundSet[]; buttons: SoundButton[] } | null = null;
  let activeSet = localPref('sb.set', 'default');
  let search = '';

  const wrap = h('div', { class: 'page-wrap' });
  container.append(wrap);

  // Локальный Web Audio для воспроизведения звуков на этом устройстве
  let audioCtx: AudioContext | null = null;
  const buffers = new Map<string, AudioBuffer>();
  const activeNodes = new Map<string, AudioBufferSourceNode[]>();
  const localPlay = localPref('sb.localPlay', isElectron() ? '1' : '1');

  function ctx(): AudioContext {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  }

  async function playSound(b: SoundButton): Promise<void> {
    if (localPlay !== '1') return;
    try {
      const ac = ctx();
      let buf = buffers.get(b.id);
      if (!buf) {
        const res = await fetch(`/api/media/sound/${b.id}`);
        if (!res.ok) throw new Error('Звук не найден. Возможно, файл был удалён.');
        const arr = await res.arrayBuffer();
        buf = await ac.decodeAudioData(arr);
        buffers.set(b.id, buf);
      }
      // Наложение: если запрещено — останавливаем предыдущие
      if (!b.overlap) stopButton(b.id);
      const src = ac.createBufferSource();
      src.buffer = buf;
      const gain = ac.createGain();
      gain.gain.value = b.volume;
      src.connect(gain).connect(ac.destination);
      if (b.mode === 'loop') src.loop = true;
      src.start();
      const list = activeNodes.get(b.id) || [];
      list.push(src);
      activeNodes.set(b.id, list);
      src.onended = () => {
        const l = activeNodes.get(b.id) || [];
        const i = l.indexOf(src);
        if (i >= 0) l.splice(i, 1);
      };
    } catch (e) {
      toast('error', (e as Error).message || 'Не удалось воспроизвести звук');
    }
  }

  function stopButton(id: string): void {
    for (const src of activeNodes.get(id) || []) {
      try { src.stop(); } catch { /* уже остановлен */ }
    }
    activeNodes.set(id, []);
  }

  function stopAllLocal(): void {
    for (const id of [...activeNodes.keys()]) stopButton(id);
  }

  // Команды от сервера: триггер/стоп-все (в т.ч. глобальные хоткеи)
  const onSbCommand = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { action: string; payload?: { buttonId?: string } };
    if (detail.action === 'stopAll') { stopAllLocal(); return; }
    if (detail.action === 'trigger' && detail.payload?.buttonId) {
      const b = config?.buttons.find(x => x.id === detail.payload?.buttonId);
      if (!b) return;
      // Режим toggle: повторное нажатие останавливает
      if (b.mode === 'toggle' && (activeNodes.get(b.id)?.length || 0) > 0) { stopButton(b.id); return; }
      void playSound(b);
    }
  };
  document.addEventListener('sonic:soundboard', onSbCommand);

  async function load(): Promise<void> {
    clear(wrap);
    wrap.append(spinner());
    try {
      config = (await api.get<{ config: { sets: SoundSet[]; buttons: SoundButton[] } }>('/api/soundboard')).config;
      if (!config.sets.some(s => s.id === activeSet)) activeSet = config.sets[0].id;
      render();
    } catch {
      clear(wrap);
    }
  }

  async function save(): Promise<void> {
    if (!config) return;
    await api.put('/api/soundboard', config);
  }

  function render(): void {
    if (!config) return;
    clear(wrap);
    const head = h('div', { class: 'page-head' },
      h('h2', { class: 'page-title' }, 'Soundboard'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', html: icon('folderPlus') + '<span>Добавить звук</span>', onclick: () => void addSound() }),
        h('button', { class: 'btn danger', html: ICONS.stop + '<span>Стоп все</span>', onclick: () => void stopAll() })));
    wrap.append(head);

    // Наборы
    const setsRow = h('div', { class: 'tabs sets' });
    for (const s of config.sets) {
      const tab = h('button', { class: 'tab' + (activeSet === s.id ? ' active' : ''),
        onclick: () => { activeSet = s.id; setLocalPref('sb.set', activeSet); render(); },
        oncontextmenu: (e) => { e.preventDefault(); void editSet(s); } }, s.name);
      setsRow.append(tab);
    }
    setsRow.append(h('button', { class: 'tab add', html: icon('plus'), title: 'Новый набор', onclick: () => void addSet() }));
    wrap.append(setsRow);

    // Поиск и опции
    const optsRow = h('div', { class: 'toolbar slim' },
      h('div', { class: 'search-box' },
        h('span', { class: 'search-icon', html: ICONS.search }),
        h('input', { class: 'input', placeholder: 'Поиск по кнопкам', value: search, oninput: (e: Event) => { search = (e.target as HTMLInputElement).value; renderButtons(); } })));
    if (!isElectron()) {
      optsRow.append(h('label', { class: 'check-label' },
        Object.assign(h('input', { type: 'checkbox', checked: localPlay === '1' ? '' : undefined }) as HTMLInputElement, {
          onchange: (e: Event) => { setLocalPref('sb.localPlay', (e.target as HTMLInputElement).checked ? '1' : '0'); location.reload(); }
        }), ' Проигрывать звук и на этом устройстве'));
    }
    wrap.append(optsRow);

    const grid = h('div', { class: 'sb-grid', id: 'sb-grid' });
    wrap.append(grid);
    renderButtons();
  }

  function renderButtons(): void {
    const grid = document.getElementById('sb-grid');
    if (!config || !grid) return;
    clear(grid as HTMLElement);
    const buttons = config.buttons
      .filter(b => b.setId === activeSet)
      .filter(b => !search || b.name.toLowerCase().includes(search.toLowerCase()));
    if (buttons.length === 0) {
      grid.append(emptyState(ICONS.soundboard, search ? 'Ничего не найдено' : 'Кнопок пока нет',
        'Добавьте короткие аудиофайлы — они копируются в каталог приложения и доступны с телефона.',
        { label: 'Добавить звук', onClick: () => void addSound() }));
      return;
    }
    buttons.forEach((b, idx) => grid.append(soundButton(b, idx)));
  }

  function soundButton(b: SoundButton, idx: number): HTMLElement {
    const playing = (activeNodes.get(b.id)?.length || 0) > 0;
    const card = h('button', { class: `sb-btn ${playing ? 'playing' : ''}`, style: `--sb-color: ${b.color}`,
      draggable: 'true',
      onclick: () => {
        if (b.mode === 'toggle' && (activeNodes.get(b.id)?.length || 0) > 0) { stopButton(b.id); return; }
        void playSound(b);
        // Триггерим и на других устройствах
        void api.post('/api/soundboard/trigger', { buttonId: b.id }).catch(() => {});
      },
      oncontextmenu: (e) => { e.preventDefault(); void editButton(b); } },
      h('span', { class: 'sb-icon', html: icon(b.icon || 'sound') }),
      h('span', { class: 'sb-name' }, b.name),
      b.hotkey ? h('span', { class: 'sb-hotkey' }, b.hotkey) : null,
      h('span', { class: 'sb-mode' }, b.mode === 'loop' ? '↻' : b.mode === 'toggle' ? '⇄' : '▶'));

    card.addEventListener('dragstart', (e) => {
      (e as DragEvent).dataTransfer?.setData('sb-index', String(idx));
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => e.preventDefault());
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number((e as DragEvent).dataTransfer?.getData('sb-index'));
      if (!isFinite(from)) return;
      reorderButtons(b, from);
    });
    return card;
  }

  async function reorderButtons(target: SoundButton, fromIdx: number): Promise<void> {
    if (!config) return;
    const setButtons = config.buttons.filter(b => b.setId === activeSet);
    const toIdx = setButtons.findIndex(b => b.id === target.id);
    if (toIdx < 0 || fromIdx === toIdx) return;
    const idsOrder = setButtons.map(b => b.id);
    const [moved] = idsOrder.splice(fromIdx, 1);
    idsOrder.splice(toIdx, 0, moved);
    const setIds = new Set(idsOrder);
    const rest = config.buttons.filter(b => !setIds.has(b.id));
    const ordered = idsOrder.map(id => config!.buttons.find(b => b.id === id)!).filter(Boolean);
    config.buttons = [...ordered, ...rest];
    await save();
    renderButtons();
  }

  async function stopAll(): Promise<void> {
    stopAllLocal();
    await api.post('/api/soundboard/stop-all', {});
    renderButtons();
  }

  async function addSound(): Promise<void> {
    // desktop: диалог выбора файлов; web: input type=file
    if (isElectron()) {
      const files = await (window as unknown as { sonicDesktop: { pickFiles(k: string): Promise<string[]> } }).sonicDesktop.pickFiles('sound');
      if (!files || files.length === 0) return;
      for (const f of files) {
        try {
          await api.post('/api/soundboard/import', { sourcePath: f });
        } catch (e) { toast('error', (e as Error).message); }
      }
      await load();
    } else {
      const input = h('input', { type: 'file', accept: 'audio/*', multiple: true }) as HTMLInputElement;
      input.addEventListener('change', async () => {
        for (const file of Array.from(input.files || [])) {
          try {
            const buf = await file.arrayBuffer();
            await api.postRaw(`/api/soundboard/upload?name=${encodeURIComponent(file.name)}`, buf);
          } catch (e) { toast('error', (e as Error).message); }
        }
        toast('success', 'Звуки добавлены');
        await load();
      });
      input.click();
    }
  }

  async function addSet(): Promise<void> {
    const name = await promptDialog('Новый набор', 'Название набора');
    if (!name) return;
    await api.put('/api/soundboard', { ...config, sets: [...(config?.sets || []), { id: crypto.randomUUID(), name }] });
    await load();
  }

  async function editSet(s: SoundSet): Promise<void> {
    modal('Набор: ' + s.name, (body, close) => {
      const renameBtn = h('button', { class: 'btn', onclick: async () => {
        const name = await promptDialog('Переименовать набор', 'Название', s.name);
        if (!name) return;
        await api.put('/api/soundboard', { sets: config!.sets.map(x => x.id === s.id ? { ...x, name } : x) });
        close(); await load();
      } }, 'Переименовать');
      const delBtn = h('button', { class: 'btn danger', onclick: async () => {
        const ok = await confirmDialog('Удалить набор', `Удалить «${s.name}» вместе со звуками?`, 'Удалить', true);
        if (!ok) return;
        try {
          const sets = config!.sets.filter(x => x.id !== s.id);
          if (sets.length === 0) { toast('error', 'Должен остаться хотя бы один набор'); return; }
          await api.put('/api/soundboard', { sets, buttons: config!.buttons.filter(b => b.setId !== s.id) });
          close(); await load();
        } catch (e) { toast('error', (e as Error).message); }
      } }, 'Удалить набор и звуки');
      body.append(h('div', { class: 'btn-col' }, renameBtn, delBtn));
    });
  }

  async function editButton(b: SoundButton): Promise<void> {
    modal('Кнопка: ' + b.name, (body, close) => {
      const name = h('input', { class: 'input', value: b.name }) as HTMLInputElement;
      // Цвет
      const colors = ['#7c6cff', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#f472b6', '#4ade80', '#f87171', '#60a5fa'];
      const colorRow = h('div', { class: 'swatches' });
      let color = b.color;
      for (const c of colors) {
        const sw = h('button', { class: 'swatch' + (c === b.color ? ' active' : ''), style: `background:${c}` });
        sw.addEventListener('click', () => {
          color = c;
          colorRow.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
          sw.classList.add('active');
        });
        colorRow.append(sw);
      }
      // Иконка
      const icons = ['sound', 'play', 'music', 'alert', 'check', 'heart', 'video', 'text', 'image', 'clock'];
      const iconRow = h('div', { class: 'swatches' });
      let iconSel = b.icon;
      for (const ic of icons) {
        const sw = h('button', { class: 'swatch icon' + (ic === b.icon ? ' active' : ''), html: icon(ic) });
        sw.addEventListener('click', () => {
          iconSel = ic;
          iconRow.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
          sw.classList.add('active');
        });
        iconRow.append(sw);
      }
      // Громкость
      const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(b.volume) }) as HTMLInputElement;
      const volLabel = h('span', { class: 'range-value' }, Math.round(b.volume * 100) + '%');
      vol.addEventListener('input', () => { volLabel.textContent = Math.round(Number(vol.value) * 100) + '%'; });
      // Режим
      const mode = h('select', { class: 'input select' },
        h('option', { value: 'once', selected: b.mode === 'once' ? '' : undefined }, 'Один раз'),
        h('option', { value: 'loop', selected: b.mode === 'loop' ? '' : undefined }, 'Повтор до остановки'),
        h('option', { value: 'toggle', selected: b.mode === 'toggle' ? '' : undefined }, 'Стоп при повторном нажатии')) as HTMLSelectElement;
      // Наложение
      const overlap = h('input', { type: 'checkbox', checked: b.overlap ? '' : undefined }) as HTMLInputElement;
      // Хоткей
      const hotkey = h('input', { class: 'input', value: b.hotkey || '', placeholder: 'Например: CommandOrControl+Shift+1', readonly: '' }) as HTMLInputElement;
      const recBtn = h('button', { class: 'btn ghost', onclick: () => {
        recBtn.textContent = 'Нажмите сочетание…';
        const handler = (e: KeyboardEvent): void => {
          e.preventDefault();
          e.stopPropagation();
          const parts: string[] = [];
          if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
          if (e.altKey) parts.push('Alt');
          if (e.shiftKey) parts.push('Shift');
          const key = e.key.length === 1 ? e.key.toUpperCase() : e.code.replace('Key', '').replace('Digit', '');
          if (key && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
            parts.push(key);
            hotkey.value = parts.join('+');
          }
          recBtn.textContent = 'Записать клавишу';
          window.removeEventListener('keydown', handler, true);
        };
        window.addEventListener('keydown', handler, true);
      } }, 'Записать клавишу');
      const clearHk = h('button', { class: 'btn ghost', onclick: () => { hotkey.value = ''; } }, 'Сбросить');

      body.append(
        formRow('Название', name),
        formRow('Цвет', colorRow),
        formRow('Значок', iconRow),
        formRow('Громкость', h('div', { class: 'range-wrap' }, vol, volLabel)),
        formRow('Режим', mode),
        formRow('Наложение звуков', h('label', { class: 'check-label' }, overlap, ' разрешить наложение')),
        formRow('Горячая клавиша (глобальная)', h('div', { class: 'btn-row' }, hotkey, recBtn, clearHk)),
        h('div', { class: 'btn-row end' },
          h('button', { class: 'btn ghost', onclick: close }, 'Отмена'),
          h('button', { class: 'btn danger', onclick: async () => {
            const ok = await confirmDialog('Удалить кнопку', `Удалить «${b.name}»?`, 'Удалить', true);
            if (!ok) return;
            await api.del(`/api/soundboard/button/${b.id}`);
            close(); await load();
          } }, 'Удалить'),
          h('button', { class: 'btn accent', onclick: async () => {
            await api.put('/api/soundboard', {
              buttons: config!.buttons.map(x => x.id === b.id ? {
                ...x, name: name.value.trim() || x.name, color, icon: iconSel,
                volume: Number(vol.value), mode: mode.value as SoundMode,
                overlap: overlap.checked, hotkey: hotkey.value || undefined
              } : x)
            });
            buffers.delete(b.id);
            close(); await load();
            toast('success', 'Кнопка сохранена');
          } }, 'Сохранить')));
    });
  }

  function formRow(label: string, control: HTMLElement): HTMLElement {
    return h('div', { class: 'form-row' }, h('label', { class: 'form-label' }, label), control);
  }

  const offSnap = snapshotListener((s) => {
    if (s.revisions.soundboard && config) {
      // Перезагружаем конфиг, если изменён другим клиентом
      void load();
    }
  });
  let lastRev = 0;
  const offSnap2 = snapshotListener((s) => {
    if (s.revisions.soundboard !== lastRev) {
      if (lastRev !== 0) void load();
      lastRev = s.revisions.soundboard;
    }
  });
  void offSnap;

  void load();
  return {
    teardown: () => {
      stopAllLocal();
      document.removeEventListener('sonic:soundboard', onSbCommand);
      offSnap();
      offSnap2();
    }
  };
}
