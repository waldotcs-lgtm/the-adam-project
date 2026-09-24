(function () {
  const IIIF = 'https://www.davidrumsey.com/luna/servlet/iiif/RUMSEY~8~1~226099~5505934';
  const state = {
    cal: null,
    hotspots: [],
    streams: [],
    tours: [],
    panels: [],
    ocrLabels: [],
    viewer: null,
    pinnedYear: null,
    activeId: null,
    activeStreamId: null,
    searchIndex: [],
    syncingYearUI: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const isPhone = () => window.matchMedia('(max-width: 720px)').matches;

  async function loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error('Failed to load ' + path);
    return r.json();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function openPanel(html) {
    if (isPhone()) {
      $('#sheet-body').innerHTML = html;
      $('#bottom-sheet').hidden = false;
      $('#side-panel').hidden = true;
    } else {
      $('#panel-body').innerHTML = html;
      $('#side-panel').hidden = false;
      $('#bottom-sheet').hidden = true;
    }
    $('#menu-dropdown').hidden = true;
  }

  function closePanel() {
    $('#side-panel').hidden = true;
    $('#bottom-sheet').hidden = true;
    state.activeId = null;
    clearStreamHighlight();
    document.querySelectorAll('.hotspot.active').forEach((el) => el.classList.remove('active'));
  }

  function iiifThumb(x, y, w, h, outW) {
    outW = outW || 96;
    const pad = 20;
    const x0 = Math.max(0, Math.floor(x - pad));
    const y0 = Math.max(0, Math.floor(y - pad));
    const rw = Math.max(40, Math.floor(w + pad * 2));
    const rh = Math.max(40, Math.floor(h + pad * 2));
    return IIIF + '/' + x0 + ',' + y0 + ',' + rw + ',' + rh + '/' + outW + ',/0/default.jpg';
  }

  function hotspotHTML(h) {
    const years =
      h.yearStart === h.yearEnd
        ? state.cal.formatYear(h.yearStart)
        : state.cal.formatYear(h.yearStart) + ' – ' + state.cal.formatYear(h.yearEnd);
    const thumb = iiifThumb(h.x, h.y, h.w, h.h, 280);
    return (
      '<h2>' + escapeHtml(h.label) + '</h2>' +
      '<div class="meta">' + escapeHtml(years) + ' · ' + escapeHtml(h.type || '') +
      (h.section === 'end-panels' ? ' · end panel' : '') + '</div>' +
      (h.notPictured ? '<p class="uncertain">Not pictured on the chart; placed at its year.</p>' : (h.approx || h.uncertain ? '<p class="uncertain">Approximate — ' + escapeHtml(h.note || 'placed at the year; no dedicated label clearly readable in crop') + '</p>' : '')) +
      '<p class="note">' + escapeHtml(h.note || '') + '</p>' +
      '<img class="thumb" style="width:100%;height:auto;max-height:180px;object-fit:contain;margin-bottom:0.75rem" src="' + thumb + '" alt="" />' +
      '<button type="button" class="btn" data-zoom-hotspot="' + escapeHtml(h.id) + '">Zoom to</button>'
    );
  }

  function showHotspot(h) {
    state.activeId = h.id;
    openPanel(hotspotHTML(h));
    document.querySelectorAll('.hotspot').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === h.id);
    });
  }

  /** Fit chart full height; center on year x (linear axis only, not end panels). */
  function zoomToYear(year, immediately) {
    const linearEnd = 1878;
    const y = Math.max(state.cal.yearStart, Math.min(linearEnd, year));
    const x = state.cal.yearToX(y);
    const img = state.viewer.world.getItemAt(0);
    if (!img) return;
    const vp = state.viewer.viewport;
    const aspect = vp.getContainerSize().x / vp.getContainerSize().y;
    // Full-height slice; near chart end, right-align to linear end so 1800s stay on axis
    const sliceW = state.cal.height * aspect;
    const linearEndX = state.cal.yearToX(linearEnd);
    let x0 = x - sliceW / 2;
    let w = sliceW;
    if (x0 + w > linearEndX) {
      x0 = Math.max(0, linearEndX - w);
      w = Math.min(w, linearEndX - x0);
    }
    if (x0 < 0) {
      w = Math.min(sliceW, linearEndX);
      x0 = 0;
    }
    const rect = img.imageToViewportRectangle(x0, 0, w, state.cal.height);
    state.pinnedYear = y;
    vp.fitBounds(rect, immediately === true);
    syncYearUI(y, true);
  }

  function zoomToHotspot(h) {
    const img = state.viewer.world.getItemAt(0);
    if (!img) return;
    // Prefer fitting full chart height while including the hotspot x
    if (h.section === 'end-panels') {
      const rect = img.imageToViewportRectangle(h.x, h.y, h.w, h.h);
      const pad = Math.max(rect.width, rect.height) * 0.2;
      state.pinnedYear = null; // panels are off the year axis
      state.viewer.viewport.fitBounds(
        new OpenSeadragon.Rect(rect.x - pad, rect.y - pad, rect.width + pad * 2, rect.height + pad * 2)
      );
      syncYearUI(1878, true);
      return;
    }
    const cx = h.x + h.w / 2;
    const year = state.cal.xToYear(cx);
    zoomToYear(year);
  }

  function zoomToPanelRegion() {
    const img = state.viewer.world.getItemAt(0);
    if (!img) return;
    // Right-hand panels start roughly after linear end (~75400)
    const x0 = 75200;
    const rect = img.imageToViewportRectangle(x0, 0, state.cal.width - x0, state.cal.height);
    state.pinnedYear = null;
    state.viewer.viewport.fitBounds(rect);
    syncYearUI(1878, true);
  }

  function centerYear() {
    const img = state.viewer.world.getItemAt(0);
    if (!img) return state.cal.yearStart;
    const bounds = state.viewer.viewport.getBounds();
    const topLeft = img.viewportToImageCoordinates(bounds.getTopLeft());
    const bottomRight = img.viewportToImageCoordinates(bounds.getBottomRight());
    const midX = (topLeft.x + bottomRight.x) / 2;
    // Clamp to linear timeline for year display when over end panels
    const linearEndX = state.cal.yearToX(1878);
    if (midX > linearEndX + 500) return 1878;
    return state.cal.xToYear(midX);
  }

  function visibleYearRange() {
    const img = state.viewer.world.getItemAt(0);
    if (!img) return { left: state.cal.yearStart, right: state.cal.yearEnd, center: state.cal.yearStart };
    const bounds = state.viewer.viewport.getBounds();
    const topLeft = img.viewportToImageCoordinates(bounds.getTopLeft());
    const bottomRight = img.viewportToImageCoordinates(bounds.getBottomRight());
    let left = state.cal.xToYear(topLeft.x);
    let right = state.cal.xToYear(bottomRight.x);
    let center = state.cal.xToYear((topLeft.x + bottomRight.x) / 2);
    const linearEndX = state.cal.yearToX(1878);
    if (topLeft.x > linearEndX) {
      left = right = center = 1878;
    } else {
      if (bottomRight.x > linearEndX) right = 1878;
      if ((topLeft.x + bottomRight.x) / 2 > linearEndX) center = 1878;
    }
    return { left, right, center };
  }

  function syncYearUI(year, forceInput) {
    state.syncingYearUI = true;
    const label = state.cal.formatYear(year);
    $('#year-display').textContent = label;
    const slider = $('#year-slider');
    if (document.activeElement !== slider) slider.value = String(year);
    const input = $('#year-input');
    if (forceInput || document.activeElement !== input) {
      input.value = label;
    }
    state.syncingYearUI = false;
  }

  function updateRulerAndSlider() {
    const r = visibleYearRange();
    const center = state.pinnedYear != null ? state.pinnedYear : r.center;
    $('#ruler-left').textContent = state.cal.formatYear(r.left);
    $('#ruler-center').textContent = state.cal.formatYear(center);
    $('#ruler-right').textContent = state.cal.formatYear(r.right);
    syncYearUI(center, false);
  }

  function syncHotspotPositions() {
    const img = state.viewer.world.getItemAt(0);
    if (!img) return;
    const layer = $('#hotspot-layer');
    const vp = state.viewer.viewport;
    state.hotspots.forEach((h) => {
      const el = layer.querySelector('.hotspot[data-id="' + h.id + '"]');
      if (!el) return;
      let hx = h.x, hy = h.y, hw = h.w, hh = h.h;
      if (h.yearOnly || h.marker === 'year-line') {
        // Thin dashed vertical marker at the year, spanning most of the chart height
        const xYear = state.cal.yearToX(h.yearStart != null ? h.yearStart : 0);
        hx = xYear - 8; hy = 200; hw = 16; hh = Math.max(6000, (state.cal.height || 8618) - 800);
      }
      const tl = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(hx, hy));
      const br = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(hx + hw, hy + hh));
      const w = Math.max(4, br.x - tl.x);
      const hgt = Math.max(4, br.y - tl.y);
      if (w < 5 && hgt < 5) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      el.style.left = tl.x + 'px';
      el.style.top = tl.y + 'px';
      el.style.width = w + 'px';
      el.style.height = hgt + 'px';
    });
    if (state.activeStreamId) highlightStream(state.activeStreamId, false);
  }

  function buildHotspotElements() {
    const layer = $('#hotspot-layer');
    layer.innerHTML = '';
    state.hotspots.forEach((h) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'hotspot' + (h.yearOnly || h.marker === 'year-line' ? ' year-only' : '');
      el.dataset.id = h.id;
      el.title = h.label + (h.notPictured ? ' (not pictured)' : '');
      el.setAttribute('aria-label', h.label);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        showHotspot(h);
      });
      layer.appendChild(el);
    });
  }

  function streamYAtYear(stream, year) {
    const segs = stream.segments || [];
    if (!segs.length) {
      return stream.yMin != null ? { yMin: stream.yMin, yMax: stream.yMax } : null;
    }
    if (year <= segs[0].year) return { yMin: segs[0].yMin, yMax: segs[0].yMax };
    if (year >= segs[segs.length - 1].year) {
      const s = segs[segs.length - 1];
      return { yMin: s.yMin, yMax: s.yMax };
    }
    for (let i = 0; i < segs.length - 1; i++) {
      if (year >= segs[i].year && year <= segs[i + 1].year) {
        const t = (year - segs[i].year) / (segs[i + 1].year - segs[i].year || 1);
        return {
          yMin: Math.round(segs[i].yMin + t * (segs[i + 1].yMin - segs[i].yMin)),
          yMax: Math.round(segs[i].yMax + t * (segs[i + 1].yMax - segs[i].yMax)),
        };
      }
    }
    return null;
  }

  function streamsAtYear(year) {
    return state.streams
      .filter((s) => year >= s.yearStart && year <= s.yearEnd)
      .map((s) => {
        const y = streamYAtYear(s, year);
        return { stream: s, yMin: y ? y.yMin : 0, yMax: y ? y.yMax : 0 };
      })
      .sort((a, b) => a.yMin - b.yMin);
  }

  function clearStreamHighlight() {
    state.activeStreamId = null;
    const el = $('#stream-highlight');
    el.hidden = true;
    el.innerHTML = '';
  }

  function highlightStream(id, pan) {
    const s = state.streams.find((x) => x.id === id);
    if (!s) return;
    state.activeStreamId = id;
    const year = state.pinnedYear != null ? state.pinnedYear : centerYear();
    const y = streamYAtYear(s, year);
    if (!y) return;
    const x0 = state.cal.yearToX(Math.max(s.yearStart, year - 40));
    const x1 = state.cal.yearToX(Math.min(s.yearEnd, year + 40));
    const img = state.viewer.world.getItemAt(0);
    const vp = state.viewer.viewport;
    const layer = $('#stream-highlight');
    layer.hidden = false;
    layer.innerHTML = '';
    const band = document.createElement('div');
    band.className = 'stream-band';
    const tl = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(Math.min(x0, x1), y.yMin));
    const br = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(Math.max(x0, x1), y.yMax));
    band.style.left = tl.x + 'px';
    band.style.top = tl.y + 'px';
    band.style.width = Math.max(8, br.x - tl.x) + 'px';
    band.style.height = Math.max(8, br.y - tl.y) + 'px';
    band.style.background = (s.color || '#3c78c8') + '55';
    layer.appendChild(band);
    if (pan) zoomToYear(year);
  }

  function atThisMoment() {
    const year = state.pinnedYear != null ? state.pinnedYear : centerYear();
    const active = streamsAtYear(year);
    const activePeople = state.hotspots.filter(
      (h) =>
        h.section !== 'end-panels' &&
        (h.type === 'people' || h.type === 'event' || h.type === 'empire') &&
        year >= h.yearStart - 8 &&
        year <= h.yearEnd + 8
    );
    let html =
      '<h2>At this moment</h2>' +
      '<div class="meta">' + escapeHtml(state.cal.formatYear(year)) + (state.pinnedYear != null ? ' (jumped year)' : ' (center of view)') + '</div>' +
      '<p class="note">Streams active now, top → bottom as on the chart. Tap to highlight.</p>' +
      '<h3 style="font-size:0.95rem;margin:0.6rem 0 0.3rem">Streams / empires</h3><ul class="list">';
    if (!active.length) html += '<li><span class="item-sub">None indexed for this year.</span></li>';
    active.forEach(({ stream: s }) => {
      html +=
        '<li data-stream="' + escapeHtml(s.id) + '">' +
        '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' +
        escapeHtml(s.color || '#888') + ';margin-top:4px;flex:0 0 auto"></span>' +
        '<div><span class="item-title">' + escapeHtml(s.name) + '</span>' +
        '<span class="item-sub">' +
        escapeHtml(state.cal.formatYear(s.yearStart)) + ' – ' +
        escapeHtml(state.cal.formatYear(s.yearEnd)) +
        '</span></div></li>';
    });
    html += '</ul><h3 style="font-size:0.95rem;margin:0.6rem 0 0.3rem">People & events nearby</h3><ul class="list">';
    if (!activePeople.length) html += '<li><span class="item-sub">No curated hotspots in ±8 years.</span></li>';
    activePeople.slice(0, 35).forEach((h) => {
      html +=
        '<li data-hotspot="' + escapeHtml(h.id) + '">' +
        '<img class="thumb" src="' + iiifThumb(h.x, h.y, h.w, h.h, 64) + '" alt="" />' +
        '<div><span class="item-title">' + escapeHtml(h.label) + '</span>' +
        '<span class="item-sub">' + escapeHtml(state.cal.formatYear(h.yearStart)) + '</span></div></li>';
    });
    html += '</ul>';
    openPanel(html);
  }

  function showSearch() {
    openPanel(
      '<h2>Search</h2>' +
        '<input class="search-box" id="search-field" type="search" placeholder="Name, place, event…" />' +
        '<ul class="list" id="search-results"></ul>'
    );
    const field = document.querySelector('#search-field');
    const results = document.querySelector('#search-results');
    const run = () => {
      const q = (field.value || '').trim().toLowerCase();
      results.innerHTML = '';
      if (q.length < 2) return;
      const hits = state.searchIndex.filter((item) => item.text.includes(q)).slice(0, 40);
      hits.forEach((item) => {
        const li = document.createElement('li');
        const thumb = item.thumb
          ? '<img class="thumb" src="' + item.thumb + '" alt="" />'
          : '';
        li.innerHTML =
          thumb +
          '<div><span class="item-title">' + escapeHtml(item.label) + '</span>' +
          '<span class="item-sub">' + escapeHtml(item.sub) + '</span></div>';
        li.addEventListener('click', () => {
          if (item.kind === 'ocr' && item.x != null) {
            const fake = {
              id: item.id || 'ocr',
              label: item.label,
              x: item.x, y: item.y, w: item.w || 800, h: item.h || 600,
              yearStart: item.year || centerYear(),
              yearEnd: item.year || centerYear(),
              type: 'label',
              note: 'Chart label from OCR index.',
            };
            if (item.id) {
              const h = state.hotspots.find((x) => x.id === item.id);
              if (h) { showHotspot(h); zoomToHotspot(h); return; }
            }
            showHotspot(fake);
            zoomToHotspot(fake);
            return;
          }
          const h = state.hotspots.find((x) => x.id === item.id);
          if (h) { showHotspot(h); zoomToHotspot(h); }
        });
        results.appendChild(li);
      });
      if (!hits.length) results.innerHTML = '<li><span class="item-sub">No matches.</span></li>';
    };
    field.addEventListener('input', run);
    field.focus();
  }

  function showTour() {
    let html = '<h2>Guided stops</h2><ul class="list">';
    state.tours.forEach((t) => {
      html +=
        '<li data-tour="' + escapeHtml(t.id) + '"><span class="item-title">' +
        escapeHtml(t.title) + '</span><span class="item-sub">' +
        escapeHtml(state.cal.formatYear(t.year)) + '</span></li>';
    });
    html += '</ul>';
    openPanel(html);
  }

  function runTour(id) {
    const t = state.tours.find((x) => x.id === id);
    if (!t) return;
    if (id === 'past-present' || id === 'presidents') {
      // Land on linear year first, then offer panels
      zoomToYear(t.year);
    } else {
      zoomToYear(t.year);
    }
    let html =
      '<h2>' + escapeHtml(t.title) + '</h2>' +
      '<div class="meta">' + escapeHtml(state.cal.formatYear(t.year)) + '</div><ul class="list">';
    (t.hotspotIds || []).forEach((hid) => {
      const h = state.hotspots.find((x) => x.id === hid);
      if (!h) return;
      html +=
        '<li data-hotspot="' + escapeHtml(h.id) + '">' +
        '<img class="thumb" src="' + iiifThumb(h.x, h.y, h.w, h.h, 64) + '" alt="" />' +
        '<div><span class="item-title">' + escapeHtml(h.label) + '</span></div></li>';
    });
    (t.panelIds || []).forEach((hid) => {
      const h = state.hotspots.find((x) => x.id === hid);
      if (!h) return;
      html +=
        '<li data-hotspot="' + escapeHtml(h.id) + '">' +
        '<img class="thumb" src="' + iiifThumb(h.x, h.y, h.w, h.h, 64) + '" alt="" />' +
        '<div><span class="item-title">' + escapeHtml(h.label) + '</span>' +
        '<span class="item-sub">end panel</span></div></li>';
    });
    html += '</ul>';
    if (t.panelIds && t.panelIds.length) {
      html += '<button type="button" class="btn" id="goto-panels">Open end panels</button>';
    }
    openPanel(html);
    const btn = document.getElementById('goto-panels');
    if (btn) btn.addEventListener('click', zoomToPanelRegion);
  }

  function showPanels() {
    const panels = state.hotspots.filter((h) => h.section === 'end-panels');
    let html =
      '<h2>End panels</h2>' +
      '<p class="note">These sit after the linear timeline (~1878). Jump-to-year for the 1800s stays on the stream section; use this list for Presidents, Past/Present, etc.</p>' +
      '<button type="button" class="btn" id="goto-panels">Zoom to panels</button><ul class="list" style="margin-top:0.75rem">';
    panels.forEach((h) => {
      html +=
        '<li data-hotspot="' + escapeHtml(h.id) + '">' +
        '<img class="thumb" src="' + iiifThumb(h.x, h.y, h.w, h.h, 64) + '" alt="" />' +
        '<div><span class="item-title">' + escapeHtml(h.label) + '</span></div></li>';
    });
    html += '</ul>';
    openPanel(html);
    const btn = document.getElementById('goto-panels');
    if (btn) btn.addEventListener('click', zoomToPanelRegion);
  }

  function showAbout() {
    openPanel(
      '<h2>The Adam Project</h2>' +
        '<div class="meta">Adams Synchronological Chart of History, 3rd ed. 1878</div>' +
        '<p class="note">An interactive viewer for Sebastian C. Adams9 (18251898) synchronological chart. Time runs left  right. Colored streams are peoples and nations.</p>' +
        '<p class="note">Dating follows Archbishop <strong>Ussher</strong> (Creation 4004 BC) as Adams printedthe charts system, not a modern-science claim.</p>' +
        '<ul class="howto"><li>Pinch or scroll to zoom; drag to pan.</li>' +
        '<li>Type a year or use the slider  the field stays in sync as you pan.</li>' +
        '<li><em>Now</em> lists streams at the center year (tap to highlight).</li>' +
        '<li><em>Panels</em> opens Presidents / Past vs Present (off the year axis).</li></ul>' +
        '<p class="note"><strong>Credit:</strong> Image: David Rumsey Map Collection, David Rumsey Map Center, Stanford Libraries (CC BY-NC-SA 3.0). Personal / free non-commercial use. Chart by Sebastian C. Adams.</p>'
    );
  }

  function bindUI() {
    $('#year-go').addEventListener('click', () => {
      const y = state.cal.parseYear($('#year-input').value);
      if (y == null) {
        $('#year-input').style.outline = '2px solid var(--accent)';
        return;
      }
      $('#year-input').style.outline = '';
      zoomToYear(y);
    });
    $('#year-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#year-go').click();
    });
    $('#year-slider').addEventListener('input', (e) => {
      if (state.syncingYearUI) return;
      const y = parseInt(e.target.value, 10);
      $('#year-display').textContent = state.cal.formatYear(y);
      $('#year-input').value = state.cal.formatYear(y);
    });
    $('#year-slider').addEventListener('change', (e) => {
      zoomToYear(parseInt(e.target.value, 10));
    });

    const actions = {
      search: showSearch,
      tour: showTour,
      moment: atThisMoment,
      panels: showPanels,
      about: showAbout,
    };
    $('#btn-search').addEventListener('click', showSearch);
    $('#btn-tour').addEventListener('click', showTour);
    $('#btn-moment').addEventListener('click', atThisMoment);
    $('#btn-panels').addEventListener('click', showPanels);
    $('#btn-about').addEventListener('click', showAbout);
    $('#btn-menu').addEventListener('click', () => {
      const m = $('#menu-dropdown');
      const btn = $('#btn-menu');
      m.hidden = !m.hidden;
      if (btn) btn.setAttribute('aria-expanded', m.hidden ? 'false' : 'true');
    });
    document.querySelectorAll('#menu-dropdown [data-menu]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fn = actions[btn.getAttribute('data-menu')];
        if (fn) fn();
      });
    });
    $('#panel-close').addEventListener('click', closePanel);
    $('#sheet-close').addEventListener('click', closePanel);

    document.addEventListener('click', (e) => {
      const tour = e.target.closest('[data-tour]');
      if (tour) { runTour(tour.getAttribute('data-tour')); return; }
      const stream = e.target.closest('[data-stream]');
      if (stream) {
        highlightStream(stream.getAttribute('data-stream'), true);
        return;
      }
      const hs = e.target.closest('[data-hotspot]');
      if (hs) {
        const h = state.hotspots.find((x) => x.id === hs.getAttribute('data-hotspot'));
        if (h) { showHotspot(h); zoomToHotspot(h); }
        return;
      }
      const z = e.target.closest('[data-zoom-hotspot]');
      if (z) {
        const h = state.hotspots.find((x) => x.id === z.getAttribute('data-zoom-hotspot'));
        if (h) zoomToHotspot(h);
      }
    });
  }

  function buildSearchIndex(ocrRaw) {
    state.searchIndex = state.hotspots.map((h) => ({
      id: h.id,
      label: h.label,
      sub:
        state.cal.formatYear(h.yearStart) +
        (h.yearEnd !== h.yearStart ? ' – ' + state.cal.formatYear(h.yearEnd) : ''),
      text: (h.label + ' ' + (h.note || '') + ' ' + (h.type || '')).toLowerCase(),
      kind: 'hotspot',
      thumb: iiifThumb(h.x, h.y, h.w, h.h, 64),
    }));
    (ocrRaw.labels || []).forEach((lab) => {
      const text = String(lab.text || '').trim();
      if (text.length < 3) return;
      let hid = null;
      if (lab.year != null) {
        let best = null, bestD = 1e9;
        state.hotspots.forEach((h) => {
          const d = Math.min(Math.abs(h.yearStart - lab.year), Math.abs(h.yearEnd - lab.year));
          if (d < bestD) { bestD = d; best = h; }
        });
        if (best && bestD < 250) hid = best.id;
      }
      const x = lab.x != null ? lab.x : hid ? state.hotspots.find((h) => h.id === hid).x : null;
      const y = lab.y != null ? lab.y : hid ? state.hotspots.find((h) => h.id === hid).y : 3000;
      const w = lab.w || 700;
      const hgt = lab.h || 500;
      state.searchIndex.push({
        id: hid,
        label: text,
        sub: (lab.year != null ? state.cal.formatYear(lab.year) + ' · ' : '') + 'chart label',
        text: text.toLowerCase(),
        kind: 'ocr',
        year: lab.year,
        x: x, y: y, w: w, h: hgt,
        thumb: x != null ? iiifThumb(x, y, w, hgt, 64) : null,
      });
    });
  }

  async function init() {
    const [calRaw, hotRaw, streamRaw, ocrRaw] = await Promise.all([
      loadJSON('data/calibration.json'),
      loadJSON('data/hotspots.json'),
      loadJSON('data/streams.json'),
      loadJSON('data/ocr-labels.json').catch(() => ({ labels: [] })),
    ]);
    state.cal = AdamsCalibration.build(calRaw);
    state.hotspots = hotRaw.hotspots || [];
    state.tours = hotRaw.tours || [];
    state.streams = streamRaw.streams || [];
    state.ocrLabels = ocrRaw.labels || [];
    buildSearchIndex(ocrRaw);

    $('#year-slider').min = String(state.cal.yearStart);
    $('#year-slider').max = String(1878);

    state.viewer = OpenSeadragon({
      id: 'osd',
      prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@4.1.0/build/openseadragon/images/',
      showNavigator: true,
      navigatorPosition: 'BOTTOM_LEFT',
      navigatorSizeRatio: 0.1,
      animationTime: 0.7,
      blendTime: 0.15,
      visibilityRatio: 1,
      constrainDuringPan: true,
      homeFillsViewer: true,
      minZoomImageRatio: 0.9,
      maxZoomPixelRatio: 2.5,
      defaultZoomLevel: 1,
      gestureSettingsTouch: { pinchToZoom: true, flickEnabled: true },
      tileSources: {
        '@context': 'http://iiif.io/api/image/2/context.json',
        '@id': IIIF,
        height: state.cal.height,
        width: state.cal.width,
        profile: ['http://iiif.io/api/image/2/level2.json'],
        protocol: 'http://iiif.io/api/image',
        tiles: [{ scaleFactors: [1, 2, 4, 8, 16, 32, 64, 128], width: 1536, height: 1536 }],
      },
    });

    buildHotspotElements();
    bindUI();

    state.viewer.addHandler('open', () => {
      zoomToYear(-4004, true);
      updateRulerAndSlider();
      syncHotspotPositions();
    });
    state.viewer.addHandler('animation', () => {
      updateRulerAndSlider();
      syncHotspotPositions();
    });
    state.viewer.addHandler('animation-finish', () => {
      updateRulerAndSlider();
      syncHotspotPositions();
    });
    state.viewer.addHandler('canvas-drag', () => {
      state.pinnedYear = null;
    });
    state.viewer.addHandler('canvas-scroll', () => {
      state.pinnedYear = null;
    });
    state.viewer.addHandler('pan', () => {
      updateRulerAndSlider();
      syncHotspotPositions();
    });
    state.viewer.addHandler('zoom', () => {
      updateRulerAndSlider();
      syncHotspotPositions();
    });
    state.viewer.addHandler('resize', syncHotspotPositions);
    window.addEventListener('resize', syncHotspotPositions);

    const params = new URLSearchParams(location.search);
    if (params.get('year')) {
      const y = state.cal.parseYear(params.get('year'));
      if (y != null) state.viewer.addHandler('open', () => zoomToYear(y));
    }
  }

  window.__ADAM__ = {
    zoomToYear: (y) => zoomToYear(y),
    zoomToHotspotId: (id) => {
      const h = state.hotspots.find((x) => x.id === id);
      if (h) { zoomToHotspot(h); showHotspot(h); return true; }
      return false;
    },
    getState: () => state,
  };

  init().catch((err) => {
    console.error(err);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<p style="color:#f3e6c8;padding:1rem">Failed to start: ' + escapeHtml(err.message) + '</p>'
    );
  });
})();
