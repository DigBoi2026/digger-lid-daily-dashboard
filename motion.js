/* =========================================================================
   DiggerLid dashboard — friendly motion layer (anime.js v4).
   FAIL-SAFE: content is never left hidden or at zero. If anime is missing,
   paused (hidden tab / wall display), or the user prefers reduced motion,
   safety timeouts snap every element to its correct final state.
   ========================================================================= */
(function () {
  const A = window.anime;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const on = !!(A && A.animate) && !reduce;
  const animate = on ? A.animate : null;
  const stagger = on ? A.stagger : null;
  // NB: we keep anime's default pause-on-hidden (so background tabs idle and don't burn CPU).
  // The safety timeouts below guarantee content still appears correctly in a hidden tab.

  const ENTRANCE_SEL = 'header#top, #kpis .kpi, #main .panel, #p2main .panel, #bottom .panel, #p2bottom .panel';

  function countUp(el) {
    const raw = (el.textContent || '').trim();
    const m = raw.match(/^([^\d\-]*)(-?[\d,]*\.?\d+)(.*)$/);
    if (!m) return;                                   // non-numeric — leave as-is
    const prefix = m[1], numStr = m[2], suffix = m[3];
    const target = parseFloat(numStr.replace(/,/g, ''));
    if (isNaN(target)) return;
    if (!on) { el.textContent = raw; return; }
    const dec = (numStr.split('.')[1] || '').length;
    const grp = numStr.includes(',');
    const fmt = v => prefix + (grp
      ? Number(v).toLocaleString('en-AU', { minimumFractionDigits: dec, maximumFractionDigits: dec })
      : v.toFixed(dec)) + suffix;
    const obj = { v: 0 };
    el.textContent = fmt(0);
    animate(obj, { v: target, duration: 720, ease: 'outExpo',
      onUpdate: () => { el.textContent = fmt(obj.v); }, onComplete: () => { el.textContent = raw; } });
    setTimeout(() => { el.textContent = raw; }, 820);   // safety: correct number even if paused
  }

  let firstPaint = true;
  window.DLmotion = {
    countUpAll(scope) { (scope || document).querySelectorAll('.k-val').forEach(countUp); },
    entrance() {
      if (!firstPaint) return;
      firstPaint = false;
      if (!on) return;                                  // reduced-motion / no anime → nothing to do
      animate('header#top', { opacity: [0, 1], translateY: [-8, 0], duration: 450, ease: 'outQuart' });
      animate('#kpis .kpi', { opacity: [0, 1], translateY: [18, 0], delay: stagger(50, { start: 90 }), duration: 520, ease: 'outQuart' });
      animate('#main .panel, #p2main .panel, #bottom .panel, #p2bottom .panel',
        { opacity: [0, 1], translateY: [22, 0], delay: stagger(70, { start: 240 }), duration: 600, ease: 'outQuart' });
      // safety: guarantee everything is visible even if the animation never completes
      setTimeout(() => { document.querySelectorAll(ENTRANCE_SEL).forEach(e => { e.style.opacity = '1'; e.style.transform = 'none'; }); }, 1600);
    }
  };
})();
