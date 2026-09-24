/** Year ↔ x mapping from data/calibration.json (loaded at runtime into window.ADAMS_CAL). */
(function (global) {
  function build(cal) {
    const anchors = (cal.anchors || []).slice().sort((a, b) => a.year - b.year);
    const years = anchors.map((a) => a.year);
    const xs = anchors.map((a) => a.x);
    const width = cal.source.width;
    const height = cal.source.height;

    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    function yearToX(year) {
      if (year <= years[0]) return xs[0];
      if (year >= years[years.length - 1]) return xs[xs.length - 1];
      for (let i = 0; i < years.length - 1; i++) {
        if (year >= years[i] && year <= years[i + 1]) {
          const t = (year - years[i]) / (years[i + 1] - years[i]);
          return lerp(xs[i], xs[i + 1], t);
        }
      }
      return xs[xs.length - 1];
    }

    function xToYear(x) {
      if (x <= xs[0]) return years[0];
      if (x >= xs[xs.length - 1]) return years[years.length - 1];
      for (let i = 0; i < xs.length - 1; i++) {
        if (x >= xs[i] && x <= xs[i + 1]) {
          const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
          return Math.round(lerp(years[i], years[i + 1], t));
        }
      }
      return years[years.length - 1];
    }

    function formatYear(y) {
      if (y < 0) return Math.abs(y) + ' BC';
      if (y === 0) return 'AD 1';
      return 'AD ' + y;
    }

    function parseYear(text) {
      if (text == null) return null;
      const s = String(text).trim().toUpperCase().replace(/,/g, '').replace(/\./g, '');
      if (!s) return null;
      let m = s.match(/^(-?\d+)\s*(BC|BCE)?$/);
      if (m) {
        let n = parseInt(m[1], 10);
        if (m[2]) n = -Math.abs(n);
        return n;
      }
      m = s.match(/^(AD|CE)\s*(-?\d+)$/);
      if (m) return Math.abs(parseInt(m[2], 10));
      m = s.match(/^(-?\d+)\s*(AD|CE)$/);
      if (m) return Math.abs(parseInt(m[1], 10));
      return null;
    }

    return {
      cal,
      anchors,
      width,
      height,
      yearStart: cal.layout.yearStart,
      yearEnd: cal.layout.yearEnd,
      yearToX,
      xToYear,
      formatYear,
      parseYear,
    };
  }

  global.AdamsCalibration = { build };
})(window);
