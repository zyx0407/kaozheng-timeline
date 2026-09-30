/* 大学生日历 · 逻辑
   数据在 数据.js（window.KAOZHENG），这里只管：月份轴 → 卡片 → 筛选 → 状态标记
   零依赖、零构建、双击 index.html 也能跑
   调试开关：?still=1 关动效（出图用）· ?theme=day|night 强制配色 · ?cat=语言 预筛 · ?probe=1 只读探针 · ?share=<证 id> 直接摊开那张卡的分享卡（出图 / 验收用） */
(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════
     二维码（自己写的，零依赖）
     只实现这页够用的一档：字节模式(UTF-8) + 纠错等级 M + 版本 1~10
     （版本 10-M 能装 213 字节，分享链接一般 40~90 字节，够用）
     接口：window.__qr.encode(text) → {size, modules:[['0','1'...],...]}
     规范要点：BCH(15,5) 格式信息 · GF(256) RS 纠错(0x11D) · 8 个掩码取罚分最低
     ══════════════════════════════════════════════════════════ */
  var QR = (function () {
    /* 每版的（块数, 数据码字/块, 纠错码字/块）——**M 档、版本 1~10**
       ⚠️ 这张表必须逐版核，凭记忆写必错（2026-09-27 真踩：v3 写成 2 块×22，
          正确是 1 块×44，结果码字总数 96 ≠ 70，扫不出来）。
       数据来源：Python qrcode 库 `base.py` 的 RS_BLOCK_TABLE（M 档那一行），
       它给的是 (块数, 总码字, 数据码字)，这里换算成 (块数, 数据, 纠错=总−数据)。 */
    var BLK = {
      1: [[1, 16, 10]],
      2: [[1, 28, 16]],
      3: [[1, 44, 26]],
      4: [[2, 32, 18]],
      5: [[2, 43, 24]],
      6: [[4, 27, 16]],
      7: [[4, 31, 18]],
      8: [[2, 38, 22], [2, 39, 22]],
      9: [[3, 36, 22], [2, 37, 22]],
      10: [[4, 43, 26], [1, 44, 26]]
    };
    /* 校正图形中心点（版本 1 没有） */
    var ALIGN = {
      1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
      6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
    };

    function utf8Bytes(str) {
      var out = [], i, c;
      for (i = 0; i < str.length; i++) {
        c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
          var c2 = str.charCodeAt(++i);
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return out;
    }
    function totalDataCodewords(v) { var t = 0; BLK[v].forEach(function (b) { t += b[0] * b[1]; }); return t; }
    function totalCodewords(v) {
      var t = 0; BLK[v].forEach(function (b) { t += b[0] * (b[1] + b[2]); }); return t;
    }
    function pickVersion(byteLen) {
      for (var v = 1; v <= 10; v++) {
        var cap = totalDataCodewords(v) * 8 - 4 - (v <= 9 ? 8 : 16);      // 扣掉模式指示符与计数位
        if (byteLen * 8 <= cap) return v;
      }
      return 0;
    }

    /* ── GF(256) 与 RS ── */
    var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
    (function () {
      var x = 1;
      for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
      for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
    })();
    function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }
    /* g(x) = Π(x − α^i)，i = 0..n-1 */
    function rsGenerator(n) {
      var g = [1];
      for (var i = 0; i < n; i++) {
        var ng = new Array(g.length + 1).fill(0);
        for (var j = 0; j < g.length; j++) {
          ng[j] ^= g[j];                       // × x
          ng[j + 1] ^= gmul(g[j], EXP[i]);     // × α^i
        }
        g = ng;
      }
      return g;
    }
    function rsEncode(data, ecLen) {
      var gen = rsGenerator(ecLen);
      var res = new Array(data.length + ecLen).fill(0);
      for (var i = 0; i < data.length; i++) res[i] = data[i];
      for (var k = 0; k < data.length; k++) {
        var coef = res[k];
        if (coef === 0) continue;
        for (var m = 0; m < gen.length; m++) res[k + m] ^= gmul(gen[m], coef);
      }
      return res.slice(data.length);
    }

    /* ── 数据编码：字节模式 → 码字 → 分块 RS → 交织 ──
       位流顺序**必须**是：模式指示符(0100) → 字符计数 → 数据字节。
       ⚠️ 2026-09-27 真踩两次：① 用 unshift(0,1,0,0) 会插成 0010（数字模式）；
       ② 把计数位 push 在数据之后 → 整条码字流全错、扫不出来。 */
    function toCodewords(bytes, v) {
      var dataCw = totalDataCodewords(v);
      var bits = [0, 1, 0, 0];                                   // ① 模式指示符：字节模式
      var i, b, cc = bytes.length;
      if (v <= 9) { for (b = 7; b >= 0; b--) bits.push((cc >> b) & 1); }          // ② 计数（v1~9 是 8 位）
      else { for (b = 15; b >= 0; b--) bits.push((cc >> b) & 1); }                //   v10+ 是 16 位
      for (i = 0; i < bytes.length; i++) for (b = 7; b >= 0; b--) bits.push((bytes[i] >> b) & 1);   // ③ 数据
      var cap = dataCw * 8;
      for (i = 0; i < 4 && bits.length < cap; i++) bits.push(0);   // 终止符
      while (bits.length % 8) bits.push(0);                        // 补齐到字节
      var cw = [];
      for (i = 0; i < bits.length; i += 8) {
        var n = 0;
        for (b = 0; b < 8; b++) n = (n << 1) | bits[i + b];
        cw.push(n);
      }
      var pad = [0xec, 0x11], p = 0;
      while (cw.length < dataCw) cw.push(pad[p++ % 2]);

      var blocks = [], pos = 0, maxData = 0, maxEc = 0;
      BLK[v].forEach(function (bs) {
        for (var k = 0; k < bs[0]; k++) {
          var d = cw.slice(pos, pos + bs[1]); pos += bs[1];
          var e = rsEncode(d, bs[2]);
          blocks.push({ d: d, e: e });
          maxData = Math.max(maxData, d.length);
          maxEc = Math.max(maxEc, e.length);
        }
      });
      var out = [], bi;
      for (i = 0; i < maxData; i++) for (bi = 0; bi < blocks.length; bi++) if (i < blocks[bi].d.length) out.push(blocks[bi].d[i]);
      for (i = 0; i < maxEc; i++) for (bi = 0; bi < blocks.length; bi++) if (i < blocks[bi].e.length) out.push(blocks[bi].e[i]);
      return out;
    }

    /* ── 功能图形 ── */
    function newM(v) {
      var n = v * 4 + 17, m = [], i, j;
      for (i = 0; i < n; i++) { m.push([]); for (j = 0; j < n; j++) m[i].push(null); }
      return m;
    }
    function placeFinder(m, r, c) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        var inRing = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        var inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        m[rr][cc] = (inside && (inRing || inCore)) ? 1 : 0;
      }
    }
    /* 哪些位置是功能图形 + 格式信息区（数据位要跳过） */
    function reserveFunction(m, v) {
      var n = m.length, i, j;
      var fn = [];
      for (i = 0; i < n; i++) { fn.push([]); for (j = 0; j < n; j++) fn[i].push(false); }
      function mark(r, c) { if (r >= 0 && c >= 0 && r < n && c < n) fn[r][c] = true; }
      [[0, 0], [0, n - 7], [n - 7, 0]].forEach(function (p) {
        for (i = -1; i <= 7; i++) for (j = -1; j <= 7; j++) mark(p[0] + i, p[1] + j);
      });
      for (i = 8; i < n - 8; i++) { mark(6, i); mark(i, 6); }
      var al = ALIGN[v];
      for (i = 0; i < al.length; i++) for (j = 0; j < al.length; j++) {
        var r = al[i], c = al[j];
        if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
        for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
      }
      for (i = 0; i <= 8; i++) { mark(8, i); mark(i, 8); }
      for (i = n - 8; i < n; i++) { mark(8, i); mark(i, 8); }
      mark(n - 8, 8);
      if (v >= 7) for (i = 0; i < 6; i++) for (j = 0; j < 3; j++) { mark(n - 11 + j, i); mark(i, n - 11 + j); }
      return fn;
    }
    function drawFunction(m, v) {
      var n = m.length, i, j;
      placeFinder(m, 0, 0); placeFinder(m, 0, n - 7); placeFinder(m, n - 7, 0);
      for (i = 8; i < n - 8; i++) { m[6][i] = (i % 2 === 0) ? 1 : 0; m[i][6] = (i % 2 === 0) ? 1 : 0; }
      var al = ALIGN[v];
      for (i = 0; i < al.length; i++) for (j = 0; j < al.length; j++) {
        var r = al[i], c = al[j];
        if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
        for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
          m[r + dr][c + dc] = (Math.max(Math.abs(dr), Math.abs(dc)) !== 1) ? 1 : 0;
        }
      }
      m[n - 8][8] = 1;
      return m;
    }

    /* ── BCH：格式信息(15,5) 与 版本信息(18,6) ── */
    function bchFormat(data5) {
      var d = data5 << 10;
      for (var i = 4; i >= 0; i--) if (d & (1 << (i + 10))) d ^= 0x537 << i;
      return ((data5 << 10) | d) ^ 0x5412;
    }
    function bchVersion(ver) {
      var d = ver << 12;
      for (var i = 5; i >= 0; i--) if (d & (1 << (i + 12))) d ^= 0x1f25 << i;
      return (ver << 12) | d;
    }

    /* ── 8 个掩码 ── */
    var MASKS = [
      function (r, c) { return (r + c) % 2 === 0; },
      function (r, c) { return r % 2 === 0; },
      function (r, c) { return c % 3 === 0; },
      function (r, c) { return (r + c) % 3 === 0; },
      function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
      function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
      function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
      function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
    ];
    function penalty(m, n) {
      var p = 0, i, j, k, run, dark = 0;
      for (i = 0; i < n; i++) {
        run = 1;
        for (j = 1; j < n; j++) { if (m[i][j] === m[i][j - 1]) run++; else { if (run >= 5) p += 3 + (run - 5); run = 1; } }
        if (run >= 5) p += 3 + (run - 5);
        run = 1;
        for (j = 1; j < n; j++) { if (m[j][i] === m[j - 1][i]) run++; else { if (run >= 5) p += 3 + (run - 5); run = 1; } }
        if (run >= 5) p += 3 + (run - 5);
      }
      for (i = 0; i < n - 1; i++) for (j = 0; j < n - 1; j++) {
        var v = m[i][j];
        if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) p += 3;
      }
      var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      function hasPat(arr, at, pat) { for (var t = 0; t < pat.length; t++) if (arr[at + t] !== pat[t]) return false; return true; }
      for (i = 0; i < n; i++) {
        var row = m[i], col = [];
        for (k = 0; k < n; k++) col.push(m[k][i]);
        for (j = 0; j + 11 <= n; j++) {
          if (hasPat(row, j, pat1) || hasPat(row, j, pat2)) p += 40;
          if (hasPat(col, j, pat1) || hasPat(col, j, pat2)) p += 40;
        }
      }
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) if (m[i][j]) dark++;
      p += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
      return p;
    }
    /* 格式信息（纠错等级 M = 00）+ 固定深色模块。
       ⚠️ 两份拷贝的位序方向**相反**，凭印象写必错（2026-09-27 真踩，只差 4 个模块却难查）。
       布局以 Python qrcode 库 `main.py :: setup_type_info` 为准：
         · 竖排 (r=n-15+i, 8) 用 bit i   → bit14 落在 (0,8)   ← 即左下角拷贝
         · 横排 (8, n-1-i)    用 bit i   → bit14 落在 (8,n-15)
         另有 2 位单独落在 (8,7)(8,8)、(7,8)。 */
    function putFormat(m, n, mask) {
      var bits = bchFormat(mask);        // 15 位
      var i, bit = function (k) { return (bits >> k) & 1; };
      for (i = 0; i < 15; i++) {
        var v = bit(i);
        // 竖排
        if (i < 6) m[i][8] = v;
        else if (i < 8) m[i + 1][8] = v;
        else m[n - 15 + i][8] = v;
        // 横排
        if (i < 8) m[8][n - i - 1] = v;
        else if (i < 9) m[8][15 - i] = v;
        else m[8][14 - i] = v;
      }
      m[n - 8][8] = 1;                   // 固定深色模块
    }
    function putVersion(m, n, v) {
      var bits = bchVersion(v);
      for (var i = 0; i < 18; i++) {
        var bit = (bits >> i) & 1;
        m[Math.floor(i / 3)][n - 11 + (i % 3)] = bit;
        m[n - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }

    /* ── 主入口 ── */
    function encode(text) {
      var bytes = utf8Bytes(String(text));
      var v = pickVersion(bytes.length);
      if (!v) return null;                                    // 太长（上层会退回不显示码）
      var n = v * 4 + 17;
      var codewords = toCodewords(bytes, v);
      var dataBits = [];
      codewords.forEach(function (cw) { for (var b = 7; b >= 0; b--) dataBits.push((cw >> b) & 1); });

      var base = drawFunction(newM(v), v);
      var fn = reserveFunction(base, v);
      var idx = 0, up = true;
      for (var col = n - 1; col > 0; col -= 2) {
        if (col === 6) col--;                                 // 跳过定时图形那一列
        for (var t = 0; t < n; t++) {
          var row = up ? (n - 1 - t) : t;
          for (var s = 0; s < 2; s++) {
            var c2 = col - s;
            if (fn[row][c2]) continue;
            base[row][c2] = idx < dataBits.length ? dataBits[idx] : 0;
            idx++;
          }
        }
        up = !up;
      }

      var best = null, bestP = Infinity, bestMask = -1;
      for (var mk = 0; mk < 8; mk++) {
        var cand = base.map(function (r) { return r.slice(); });
        for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
          if (!fn[i][j] && MASKS[mk](i, j)) cand[i][j] ^= 1;
        }
        putFormat(cand, n, mk);
        if (v >= 7) putVersion(cand, n, v);
        var pn = penalty(cand, n);
        if (pn < bestP) { bestP = pn; best = cand; bestMask = mk; }
      }
      return {
        version: v, size: n, ecc: 'M', mask: bestMask, penalty: bestP,
        modules: best.map(function (r) { return r.map(function (x) { return x ? '1' : '0'; }); })
      };
    }

    return {
      encode: encode,
      codewords: function (text) {                      // 给码字级核对用（test\qr-dump.mjs）
        var bytes = utf8Bytes(String(text));
        var v = pickVersion(bytes.length);
        return v ? toCodewords(bytes, v) : null;
      },
      BLK: BLK, ALIGN: ALIGN, utf8Bytes: utf8Bytes, pickVersion: pickVersion,
      totalDataCodewords: totalDataCodewords, totalCodewords: totalCodewords,
      rsGenerator: rsGenerator, rsEncode: rsEncode, gmul: gmul
    };
  })();
  window.__qr = QR;

  /* 自检：?qrselftest=1 —— 把结构检查的结论写到 <html data-qr-selftest>，
     给无头验收读（不靠肉眼看图）。检查项：尺寸/定位图形/定时图形/固定深色模块/深色比例/各版本能力。 */
  (function () {
    if (!/[?&]qrselftest=1/.test(location.search)) return;
    var out = [];
    function mod(g, r, c) { return g.modules[r][c] === '1' ? 1 : 0; }
    function finderOK(g, r0, c0) {
      for (var r = 0; r < 7; r++) for (var c = 0; c < 7; c++) {
        var ring = (r === 0 || r === 6 || c === 0 || c === 6);
        var core = (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        if (mod(g, r0 + r, c0 + c) !== ((ring || core) ? 1 : 0)) return false;
      }
      return true;
    }
    function timingOK(g) {
      var n = g.size;
      for (var i = 8; i < n - 8; i++) {
        if (mod(g, 6, i) !== (i % 2 === 0 ? 1 : 0)) return false;
        if (mod(g, i, 6) !== (i % 2 === 0 ? 1 : 0)) return false;
      }
      return true;
    }
    // 一组真实分享链接
    var cases = [
      'https://work1.zyx0407.com/?card=cet4',
      'https://work1.zyx0407.com/?card=shipin-anquan-guanlishi',
      'https://work1.zyx0407.com/?card=zhuci-yingyangshi&theme=night'
    ];
    var rows = [];
    cases.forEach(function (t) {
      var g = QR.encode(t);
      if (!g) { rows.push({ 文本长度: t.length, 结果: '❌ 空（版本超限）' }); return; }
      var dark = 0, i, j;
      for (i = 0; i < g.size; i++) for (j = 0; j < g.size; j++) dark += mod(g, i, j);
      rows.push({
        字节: QR.utf8Bytes(t).length, 版本: g.version, 尺寸: g.size,
        定位图形: (finderOK(g, 0, 0) && finderOK(g, 0, g.size - 7) && finderOK(g, g.size - 7, 0)) ? '✓' : '✗',
        定时图形: timingOK(g) ? '✓' : '✗',
        固定深色: mod(g, g.size - 8, 8) === 1 ? '✓' : '✗',
        深色比例: (dark * 100 / (g.size * g.size)).toFixed(1) + '%'
      });
    });
    // 顺带看看版本能力：各版本能装多少字节
    var cap = [];
    for (var v = 1; v <= 10; v++) cap.push(v + ':' + (QR.totalDataCodewords(v) * 8 - 4 - (v <= 9 ? 8 : 16)) / 8);
    out = { 用例: rows, 各版本可装字节: cap.join(' ') };
    document.documentElement.setAttribute('data-qr-selftest', JSON.stringify(out));
  })();

  /* ── 数据 ─────────────────────────── */
  var KZ = window.KAOZHENG || {};
  var META = KZ.元信息 || {};
  var CATS = KZ.类别 || [];
  var BIGS = KZ.大类 || [{ id: '考证', 名: '考证' }];     // 一级大类（考研 / 考公 / 考证）；老数据没有就退化成单一类
  var ALL = (KZ.证 || []).slice();
  var MONTHS = 12;
  var DEEP = null;      // 从二维码进来的那张卡 id（?card=xxx），给探针与高亮用

  var q = location.search;
  var STILL = /[?&]still=1/.test(q);
  var PROBE_ONLY = /[?&]probe=1/.test(q);
  var PRESET_CAT = (function () {
    var m = /[?&]cat=([^&]+)/.exec(q);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  })();
  /* ?big=考研|考公|考证 —— 一级大类预筛（给深链和出图用） */
  var PRESET_BIG = (function () {
    var m = /[?&]big=([^&]+)/.exec(q);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  })();

  /* ── 小工具 ───────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function ym(s) { return String(s || '').slice(0, 7); }
  function validYM(s) { return /^\d{4}-\d{2}$/.test(ym(s)); }
  function md(a, b) { return ym(a) === ym(b); }
  /* 今天往后/往前 n 天（用本地日期的 YYYY-MM-DD 做差值，避免时区与夏令时坑） */
  function dayDiff(fromStr, toStr) {
    var a = new Date(fromStr + 'T00:00:00'), b = new Date(toStr + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }
  /* 日期文案：一律带年份。多条同月同日的批次（如公共营养师 3/6/9/12 四批）
     不带年就全糊成「11月1日 · 11月1日 · 11月1日」（2026-09-27 真踩）。 */
  function cnDate(s) {
    var t = String(s || '').trim();
    if (!t) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) { var p = t.split('-'); return p[0] + '年' + (+p[1]) + '月' + (+p[2]) + '日'; }
    if (/^\d{4}-\d{2}$/.test(t)) return t.slice(0, 4) + '年' + (+t.slice(5)) + '月';
    return t;
  }
  function rangeText(a, b) {
    if (b === undefined) b = a;      // 只递一条窗口（{起,止}）时，起止都在它自己身上
    var x = cnDate(a && a.起), y = cnDate(b && b.止);
    if (!x) return '待公布';
    if (!y || y === x) return x;
    return x + '–' + y;
  }
  /* 月序号（用于比较，形如 202609） */
  function mnum(s) { var t = ym(s); return validYM(t) ? parseInt(t.replace('-', ''), 10) : 0; }

  /* ── 时间窗口：默认从「今天所在的月」起滚 12 个月（每月 1 号自己往前滚一格）
     · 数据里 元信息.时间轴起点 = '自动'（或不写）→ 用当前月；
     · 想钉死某个月就写 '2026-09'。
     · 这样「月底不用改数据也能滚」，月更只剩「补新公布的考期」这一件事。 ── */
  var TODAY_YM = (function () {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  })();
  var START_RAW = String(META.时间轴起点 || '').trim();
  var START = (START_RAW && START_RAW !== '自动' && validYM(START_RAW)) ? ym(START_RAW) : TODAY_YM;
  var START_AUTO = !(START_RAW && START_RAW !== '自动' && validYM(START_RAW));
  var WINDOW = [];
  (function () {
    var y = parseInt(START.slice(0, 4), 10), m = parseInt(START.slice(5), 10);
    for (var i = 0; i < MONTHS; i++) {
      WINDOW.push(y + '-' + pad2(m));
      m++; if (m > 12) { m = 1; y++; }
    }
  })();
  var START_N = mnum(WINDOW[0]), END_N = mnum(WINDOW[MONTHS - 1]);
  var TODAY = todayStr(), TODAY_N = mnum(TODAY);

  /* ── 状态（只存本机）───────────────── */
  var LSKEY = 'kaozheng.status.v1';
  var STATUS = ['准备', '已拿', '不考'];
  var marks = {};
  try { marks = JSON.parse(localStorage.getItem(LSKEY) || '{}') || {}; } catch (e) { marks = {}; }
  function saveMarks() { try { localStorage.setItem(LSKEY, JSON.stringify(marks)); } catch (e) {} }

  /* ── 当前选中 ─────────────────────── */
  var cur = { big: (PRESET_BIG && findBig(PRESET_BIG)) || '全部', cat: (PRESET_CAT && findCat(PRESET_CAT)) || '全部', st: '全部', q: '' };
  function findBig(id) {
    for (var i = 0; i < BIGS.length; i++) if (BIGS[i].id === id || BIGS[i].名 === id) return BIGS[i].id;
    return null;
  }
  function bigName(id) {
    for (var i = 0; i < BIGS.length; i++) if (BIGS[i].id === id) return BIGS[i].名;
    return id;
  }
  function findCat(id) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id || CATS[i].名 === id) return CATS[i].id;
    return null;
  }
  function catName(id) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i].名;
    return id;
  }

  /* ── 一条证：派生信息 ──────────────── */
  function regs(c) { return (c.报名时间 || []).filter(Boolean); }
  function exams(c) { return (c.考试时间 || []).filter(Boolean); }

  /* （A 版改版 2026-09-27：原来的「月份点 pointsOf / 卡片左侧月份 leadMonths」随点阵轴一起下线，
     现在由 fitOf() 一次算清「哪些月有事 / 第一批报名考试」，轴与卡片共用同一份结果） */

  /* 倒计时 / 状态文案 */
  function countdown(c) {
    var rs = regs(c), es = exams(c), i, best = null;
    /* 取**最近的那一场**（别再按数据里的先后顺序取：CET 口语 11-21 排在笔试 12-12 后面，
       按顺序取会报成"还有 76 天"，其实最近一场是 11-21 = 55 天） */
    for (i = 0; i < es.length; i++) {
      var d = es[i].日;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) continue;
      if (dayDiff(TODAY, d) < 0) continue;
      if (!best || d < best) best = d;
    }
    if (best) {
      var left = dayDiff(TODAY, best);
      return { t: (left === 0 ? '今天考试' : '考试还有 ' + left + ' 天'), hot: left <= 60, cls: '' };
    }
    for (i = 0; i < rs.length; i++) {
      var r = rs[i], a = r.起, b = r.止;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a))) continue;
      if (b && /^\d{4}-\d{2}-\d{2}$/.test(String(b)) && dayDiff(TODAY, b) < 0) continue;
      var inWin = dayDiff(TODAY, a);
      if (inWin > 0) return { t: '报名还有 ' + inWin + ' 天', hot: inWin <= 30, cls: '' };
      var left = b ? dayDiff(TODAY, b) : 0;
      return { t: left > 0 ? '报名中 · 剩 ' + left + ' 天' : '报名进行中', hot: true, cls: '' };
    }
    var last = null;
    for (i = 0; i < es.length; i++) if (es[i].日 && (!last || es[i].日 > last)) last = es[i].日;
    if (last && dayDiff(TODAY, last) < 0) return { t: '本次已结束', hot: false, cls: 'done' };
    if (c.未公布) return { t: '考期待公布', hot: false, cls: '' };
    return { t: '', hot: false, cls: '' };
  }
  /* 搜索：两段式 —— 先只认「证名 / 简称 / 类别 / 官网名」；
     一条都没命中才回落到说明正文（否则「托福」的说明里提到「雅思」会把托福也搜出来） */
  function hay(c, loose) {
    var f = [c.名, c.简称, c.类别, c.官网名];
    if (loose) f = f.concat([c.说明, c.适合, c.费用]);
    return f.join(' ').toLowerCase();
  }
  /* 「专业扩展」（TEM-4/8）**不进主列表**（他 2026-09-27 定的）：默认一条不出，只有点了那枚胶囊才显示 */
  function isExt(c) { return !!c.扩展; }
  /* 除搜索以外的条件先过一遍，再决定搜索用严格还是宽松 */
  function preFiltered() {
    return ALL.filter(function (c) {
      if (cur.big !== '全部' && c.大类 !== cur.big) return false;      // 一级：考研 / 考公 / 考证
      if (cur.cat === '专业扩展') { if (!isExt(c)) return false; }
      else if (isExt(c)) return false;
      if (cur.cat !== '全部' && cur.cat !== '专业扩展' && c.类别 !== cur.cat) return false;
      var st = marks[c.id] || '';
      if (cur.st === '未标记' && st) return false;
      if (cur.st !== '全部' && cur.st !== '未标记' && st !== cur.st) return false;
      return true;
    });
  }
  var CUR = [];        // 这一轮筛选后的结果（paint() 里赋值，各处共用，别重复算）
  var LOOSE = false;   // 本轮搜索是否回落到了正文
  function applyFilters() {
    var pool = preFiltered();
    if (!cur.q) { LOOSE = false; return pool; }
    var q = cur.q.toLowerCase();
    var strict = pool.filter(function (c) { return hay(c, false).indexOf(q) >= 0; });
    if (strict.length) { LOOSE = false; return strict; }
    LOOSE = true;
    return pool.filter(function (c) { return hay(c, true).indexOf(q) >= 0; });
  }

  /* ── 吸顶：用滚动事件钉住时间轴条 ─────
     为什么不用 position:sticky：在这张页面里它只吸一截就跟着走（2026-09-27 实测），
     逐层排查没找到破坏者 → 自己钉，行为可测（test\吸顶实测.mjs 就是量它）。 */
  var pin = { on: false, box: null, pad: 0 };
  function pinCache(bar) {
    var zone = document.getElementById('stickyzone') || bar.parentNode;
    var wrap = document.querySelector('.wrap');
    var pad = wrap ? parseFloat(getComputedStyle(wrap).paddingLeft) || 0 : 0;
    bar.classList.remove('pinned');
    bar.style.width = ''; bar.style.left = ''; bar.style.top = '';
    var wr = wrap ? wrap.getBoundingClientRect() : null;
    var bh = bar.offsetHeight;
    var zTop = zone.getBoundingClientRect().top + window.pageYOffset;
    pin.box = {
      /* ⚠️ 钉住时 left/width 要用**内容容器的边框盒**：
         left = .wrap 在视口里的左边（不是内边距值！.wrap 是 margin:auto 居中的，两者差 117px，2026-09-27 真踩）
         width = .wrap 的 clientWidth（含内边距，因为 .tlbar 自己是 border-box） */
      left: wr ? Math.round(wr.left) : pad,
      w: wrap ? wrap.clientWidth : 0,
      bh: bh, vw: document.documentElement.clientWidth,
      zoneTop: zTop, zoneBottom: zTop + zone.offsetHeight, barTop: zTop
    };
    pin.pad = pad;
  }
  function pinTick() {
    var bar = document.getElementById('tlbar');
    if (!bar) return;
    // 视口宽变了（横向出不出滚动条会让它变 15px）→ 之前量的宽度就不准了，重量一次。
    // 否则钉住时左边会偏一个"滚动条 + padding"的距离。
    if (pin.box && pin.box.vw !== document.documentElement.clientWidth) {
      var wasOn = pin.on;
      pinCache(bar);
      pin.on = wasOn;
    }
    if (!pin.box || !pin.on) pinCache(bar);
    var b = pin.box, y = window.pageYOffset;
    var should = (y + b.bh > b.barTop) && (y + b.bh < b.zoneBottom);
    if (should === pin.on) return;
    if (should) {
      bar.style.width = b.w + 'px';
      bar.style.left = b.left + 'px';
      bar.style.top = '0px';
      bar.classList.add('pinned');
    } else {
      bar.style.width = ''; bar.style.left = ''; bar.style.top = '';
      bar.classList.remove('pinned');
      pinCache(bar);      // 脱开后重新量一次（高度可能被主题或筛选改过）
      return;
    }
    pin.on = should;
  }
  var pinRAF = 0;
  function onScroll() {
    if (pinRAF) return;
    pinRAF = requestAnimationFrame(function () { pinRAF = 0; pinTick(); });
  }
  /* ── 分享：分享的就是**整张卡片**（报名/考试时间 · 费用 · 官网 · 小鱼说明 + 二维码） ──
     改版前弹层里只有「一坨码 + 链接」；他 2026-09-27 定：分享的应该是整张卡，官网/费用/时间都得在图里。 */
  /* 分享链接＝当前页面地址 + ?card=<这张证>（跟着页面走，挂到 work1 也不用改） */
  function shareURL(id) {
    var base = location.origin + location.pathname;
    return base + '?card=' + encodeURIComponent(id);
  }
  /* 矩阵 → SVG（1 模块 = 1 单位，靠 width/height 缩放；不落 canvas，省得管 DPR） */
  function qrSVG(g, px) {
    var n = g.size, quiet = 2, total = n + quiet * 2, d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (g.modules[r][c] === '1') d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
      }
    }
    return '<svg viewBox="0 0 ' + total + ' ' + total + '" width="' + px + '" height="' + px +
      '" shape-rendering="crispEdges" aria-label="分享二维码" role="img">' +
      '<rect width="' + total + '" height="' + total + '" fill="#fff"/>' +
      '<path d="' + d + '" fill="#000"/></svg>';
  }
  function domainOf(u) { return String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }
  function hostOf(u) { var m = /^https?:\/\/([^/?#]+)/.exec(String(u || '')); return m ? m[1] : domainOf(u); }
  /* 分享卡上放最近一批报名 + 最近两场考试（全批次会挤成一团）。
     DOM 与 canvas 存图**共用这两个函数**，免得「页面上写两场、存下来的图只有一场」 */
  function shareRegText(c) {
    var f = fitOf(c), rs = regs(c), r = f.regs[0] || rs[0] || null;
    return r ? rangeText(r) : '全年可报名';
  }
  function shareExamText(c) {
    var f = fitOf(c), es = exams(c);
    var all = f.exams.length ? f.exams
      : es.filter(function (e) { return e.日 >= TODAY; }).sort(function (a, b) { return a.日 < b.日 ? -1 : (a.日 > b.日 ? 1 : 0); });
    if (!all.length) return c.未公布 ? '待官方公布' : '窗口内无考期';
    return all.slice(0, 2).map(function (e) {
      return cnDate(e.日) + (e.类型 ? '（' + e.类型 + '）' : '');
    }).join(' · ');
  }
  function shareCardHTML(c, g, url) {
    var reg = shareRegText(c), ex = shareExamText(c);
    var note = String(c.说明 || '').replace(/^小鱼：/, '');
    return '<div class="share-card" data-share-card="' + esc(c.id) + '">' +
      '<div class="sh-head"><span class="brand">大学生日历</span><span>阿玖 · zyx0407</span></div>' +
      '<h3>' + esc(c.名) + '</h3>' +
      (c.简称 ? '<span class="abbr">' + esc(c.简称) + '</span>' : '') +
      '<div class="sh-facts">' +
        '<div class="r"><span class="k">报名时间</span><span class="v"><span class="dates">' + esc(reg) + '</span></span></div>' +
        '<div class="r"><span class="k">考试时间</span><span class="v"><span class="dates">' + esc(ex) + '</span></span></div>' +
        '<div class="r"><span class="k">费用</span><span class="v">' + esc(c.费用 || '以官网公告为准') + '</span></div>' +
        '<div class="r"><span class="k">官方网站</span><span class="v">' + esc(c.官网名 || '待补') +
          (c.官网 ? '<span class="sub">' + esc(domainOf(c.官网)) + '</span>' : '') + '</span></div>' +
      '</div>' +
      (note ? '<p class="sh-note">小鱼：' + esc(note) + '</p>' : '') +
      '<div class="sh-qr">' +
        (g ? qrSVG(g, 96) : '<span class="noqr">这条链接太长，没生成二维码；直接复制链接发给他。</span>') +
        '<span class="qt"><b>扫码看这张卡</b>' + esc(hostOf(url)) + '<br>链接：' + esc(url) + '</span>' +
      '</div>' +
      '</div>';
  }

  /* ── 保存图片：手绘 canvas（零依赖、2 倍图） ──
     永远画**浅色版**：存下来的图是发给同学 / 贴群里的，深色版在别人那儿不好读。
     版式跟页面上的分享卡对齐；二维码按模块画，落盘后仍能被扫码器解出原链接（test\share-card-check.mjs 验它）。 */
  function shareCanvas(c, g, url) {
    var S = 2, W = 376, padX = 24, PT = 22, kCol = 62;
    var fam = '"Noto Sans SC","Source Han Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif';
    var hand = 'italic 12.8px "FangSong","仿宋","Noto Serif SC",serif'; /* 小鱼的话＝仿宋斜，跟站点 G1 一致（canvas 里 font-style 写进 shorthand） */
    var mono = '"Consolas","Cascadia Mono",monospace';
    var cInk = '#1c1d1f', cMuted = '#7e807c', cAmber = '#a8541f', cBg = '#f8f7f3', cLine = '#d9d7d1', cSoft = '#e6e4de';
    var cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    var ops = [], y = PT, qrRect = null;
    function T(t, font, color, x, yy) { ops.push({ k: 't', t: String(t), font: font, color: color, x: x, y: yy }); }
    function L(x1, y1, x2, y2, color) { ops.push({ k: 'l', x1: x1, y1: y1, x2: x2, y2: y2, color: color }); }
    function wrap(txt, font, maxW) {
      ctx.font = font;
      var out = [], line = '';
      String(txt == null ? '' : txt).split('').forEach(function (ch) {
        if (ch === '\n') { out.push(line); line = ''; return; }
        if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ch; }
        else line += ch;
      });
      out.push(line);
      return out;
    }
    /* 顶行 */
    T('大学生日历', '11px ' + mono, cAmber, padX, y + 9);
    var who = '阿玖 · zyx0407';
    ctx.font = '11px ' + mono;
    T(who, '11px ' + mono, cMuted, W - padX - ctx.measureText(who).width, y + 9);
    y += 13; L(padX, y, W - padX, y, cSoft); y += 8;
    /* 标题 + 简称 */
    wrap(c.名, '600 20px ' + fam, W - padX * 2).forEach(function (ln) { y += 27; T(ln, '600 20px ' + fam, cInk, padX, y); });
    if (c.简称) { y += 20; T(c.简称, '11px ' + mono, cMuted, padX, y); }
    /* 四行事实：左标签 + 右值（值太长就折行） */
    y += 16; L(padX, y, W - padX, y, cSoft); y += 6;
    var rows = [
      ['报名时间', shareRegText(c), true],
      ['考试时间', shareExamText(c), true],
      ['费用', c.费用 || '以官网公告为准', false],
      ['官方网站', (c.官网名 || '待补') + (c.官网 ? '（' + domainOf(c.官网) + '）' : ''), false]
    ];
    rows.forEach(function (row) {
      var vf = row[2] ? '12.5px ' + mono : '13.5px ' + fam;
      var lines = wrap(row[1], vf, W - padX * 2 - kCol);
      T(row[0], '10.5px ' + mono, cMuted, padX, y + 12);
      lines.forEach(function (ln, i) { T(ln, vf, cInk, padX + kCol, y + 12 + i * 19); });
      y += Math.max(20, lines.length * 19) + 3;
    });
    /* 小鱼那句（最多 3 行，跟页面上一样） */
    var note = String(c.说明 || '').replace(/^小鱼：/, '');
    if (note) {
      y += 13;
      var nl = wrap('小鱼：' + note, hand, W - padX * 2 - 12).slice(0, 3);
      L(padX, y + 2, padX, y + nl.length * 21 - 4, cLine);
      nl.forEach(function (ln, i) { T(ln, hand, cInk, padX + 12, y + 14 + i * 21); });
      y += nl.length * 21;
    }
    /* 二维码 + 说明 */
    y += 16; L(padX, y, W - padX, y, cSoft); y += 15;
    var qrSide = 96, tx = padX + qrSide + 14, tw = W - padX - tx;
    if (g) {
      var total = g.size + 4, mod = qrSide / total;
      ops.push({ k: 'rect', x: padX, y: y, w: qrSide, h: qrSide, color: '#fff' });
      for (var r2 = 0; r2 < g.size; r2++) {
        for (var c2 = 0; c2 < g.size; c2++) {
          if (g.modules[r2][c2] !== '1') continue;
          ops.push({ k: 'rect', x: padX + (c2 + 2) * mod, y: y + (r2 + 2) * mod, w: mod, h: mod, color: '#000' });
        }
      }
      qrRect = { x: padX, y: y, size: qrSide, n: g.size, quiet: 2 };
    }
    T('扫码看这张卡', '11.5px ' + fam, cInk, tx, y + 11);
    wrap(hostOf(url), '10.5px ' + mono, tw).forEach(function (ln, i) { T(ln, '10.5px ' + mono, cMuted, tx, y + 29 + i * 17); });
    var ul = wrap('链接：' + url, '10.5px ' + mono, tw);
    ul.forEach(function (ln, i) { T(ln, '10.5px ' + mono, cMuted, tx, y + 29 + 17 + i * 17); });
    var textH = 29 + 17 + ul.length * 17;
    y += Math.max(qrSide, textH) + 22;

    var H = y;
    cv.width = Math.round(W * S); cv.height = Math.round(H * S);
    ctx.scale(S, S);
    ctx.fillStyle = cBg; ctx.fillRect(0, 0, W, H);
    ops.forEach(function (op) {
      if (op.k === 't') { ctx.font = op.font; ctx.fillStyle = op.color; ctx.fillText(op.t, op.x, op.y); }
      else if (op.k === 'l') { ctx.strokeStyle = op.color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(op.x1, op.y1 + .5); ctx.lineTo(op.x2, op.y2 + .5); ctx.stroke(); }
      else if (op.k === 'rect') { ctx.fillStyle = op.color; ctx.fillRect(op.x, op.y, op.w, op.h); }
    });
    ctx.strokeStyle = '#cfcdc6'; ctx.lineWidth = 1; ctx.strokeRect(.5, .5, W - 1, H - 1);
    return { canvas: cv, qr: qrRect, scale: S, w: W, h: H };
  }
  /* 给验收用：把落盘那张图里的二维码区域**逐模块采样**回矩阵（证明存出来的图还能扫） */
  function shareMatrix(c, g, url) {
    var out = shareCanvas(c, g, url), q = out.qr;
    if (!q) return null;
    var ctx2 = out.canvas.getContext('2d'), mod = q.size / (q.n + q.quiet * 2), m = [];
    for (var r = 0; r < q.n; r++) {
      var row = [];
      for (var col = 0; col < q.n; col++) {
        var px = Math.round((q.x + (col + q.quiet + .5) * mod) * out.scale);
        var py = Math.round((q.y + (r + q.quiet + .5) * mod) * out.scale);
        var d = ctx2.getImageData(px, py, 1, 1).data;
        row.push(((d[0] + d[1] + d[2]) / 3) < 128 ? 1 : 0);
      }
      m.push(row);
    }
    return m;
  }
  function savePNG(cv, name) {
    function go(url) {
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
    try {
      if (cv.toBlob) cv.toBlob(function (b) { go(b ? URL.createObjectURL(b) : cv.toDataURL('image/png')); }, 'image/png');
      else go(cv.toDataURL('image/png'));
    } catch (e) { go(cv.toDataURL('image/png')); }
  }

  var shareBox = null;
  function closeShare() {
    if (!shareBox) return;
    shareBox.parentNode.removeChild(shareBox);
    shareBox = null;
  }
  function copyShareURL(url, btn) {
    var box = shareBox;
    function done(ok) {
      if (btn) btn.textContent = ok ? '已复制 ✓' : '没复制上';
      var tip = box && box.querySelector('.shade-tip');
      if (tip) tip.textContent = ok ? '链接已复制：' + url : '链接（手动复制）：' + url;
      setTimeout(function () { if (btn) btn.textContent = '复制链接'; }, 2400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (e2) { done(false); }
    }
  }
  function openShare(c) {
    closeShare();
    var url = shareURL(c.id), g = null;
    try { g = window.__qr ? window.__qr.encode(url) : null; } catch (e) { g = null; }
    shareBox = document.createElement('div');
    shareBox.className = 'shade';
    shareBox.setAttribute('data-share-for', c.id);
    shareBox.innerHTML =
      '<div class="shade-inner">' +
        '<div id="shareHost">' + shareCardHTML(c, g, url) + '</div>' +
        '<div class="shade-actions">' +
          '<button type="button" class="btn-primary" data-share-act="save">保存图片</button>' +
          '<button type="button" class="btn-ghost" data-share-act="copy">复制链接</button>' +
          '<button type="button" class="btn-ghost" data-share-act="close">关闭</button>' +
          '<span class="shade-tip">扫码就落到这张卡；发给同学存图或复制链接都行</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(shareBox);
    shareBox.addEventListener('click', function (e) {
      var t = e.target;
      if (t === shareBox) { closeShare(); return; }
      var act = t.closest && t.closest('[data-share-act]');
      if (!act) return;
      var kind = act.getAttribute('data-share-act');
      if (kind === 'close') { closeShare(); return; }
      if (kind === 'copy') { copyShareURL(url, act); return; }
      if (kind === 'save') {
        var out = shareCanvas(c, g, url);
        savePNG(out.canvas, '大学生日历-' + (c.简称 || c.名) + '.png');
        var tip = shareBox.querySelector('.shade-tip');
        if (tip) tip.textContent = '已存成 PNG（2 倍图 ' + out.canvas.width + '×' + out.canvas.height + '）';
      }
    });
    probe();
  }

  /* ── 派生：一条证在这 12 个月里落到哪些月（算一次缓存住，筛来筛去不用重算） ── */
  var FIT = {};
  function fitOf(c) {
    if (FIT[c.id]) return FIT[c.id];
    var months = {}, regList = [], exList = [], i;
    regs(c).forEach(function (r) {
      var a = ym(r.起), b = ym(r.止) || a;
      if (!a) return;
      var hit = false;
      for (i = 0; i < MONTHS; i++) {
        if (mnum(WINDOW[i]) >= mnum(a) && mnum(WINDOW[i]) <= mnum(b)) { (months[WINDOW[i]] = months[WINDOW[i]] || {}).reg = 1; hit = true; }
      }
      if (hit) regList.push(r);
    });
    exams(c).forEach(function (e) {
      var m = ym(e.日);
      if (!m || WINDOW.indexOf(m) < 0) return;
      (months[m] = months[m] || {}).exam = 1; exList.push(e);
    });
    exList.sort(function (a, b) { return a.日 < b.日 ? -1 : (a.日 > b.日 ? 1 : 0); });   // 考试日按时间排（口语常在笔试前）
    var f = { months: months, first: Object.keys(months).sort()[0] || null, regs: regList, exams: exList };
    FIT[c.id] = f;
    return f;
  }
  /* 每个月有几条在报名窗口里 / 几个考试日（喂给轴上的「报 N · 考 N」与底沿密度条） */
  function monthStats(rows) {
    var st = {};
    WINDOW.forEach(function (m) { st[m] = { n: 0, reg: 0, exam: 0 }; });
    rows.forEach(function (c) {
      var f = fitOf(c);
      Object.keys(f.months).forEach(function (m) {
        if (!st[m]) return;
        st[m].n++;
        if (f.months[m].reg) st[m].reg++;
        if (f.months[m].exam) st[m].exam++;
      });
    });
    return st;
  }
  /* 按月分组：一条证只出现在「窗口里第一个有事的月份」那一组（不重复出现） */
  function groupByMonth(rows) {
    var map = {}, none = [];
    rows.forEach(function (c) {
      var f = fitOf(c);
      if (!f.first) { none.push(c); return; }
      (map[f.first] = map[f.first] || []).push(c);
    });
    var out = Object.keys(map).sort().map(function (m) { return { ym: m, items: sortInGroup(map[m]) }; });
    if (none.length) out.push({ ym: 'wait', items: sortInGroup(none), wait: true });
    return out;
  }
  /* 组内顺序：先按类别（和筛选条一个次序），同类里**最近要有事的排前面**（跟卡片上那句倒计时对得上） */
  function sortInGroup(list) {
    return list.slice().sort(function (a, b) {
      var oa = ORDER.indexOf(a.类别), ob = ORDER.indexOf(b.类别);
      if (oa < 0) oa = 99; if (ob < 0) ob = 99;
      if (oa !== ob) return oa - ob;
      var ka = nextKey(a), kb = nextKey(b);
      return ka < kb ? -1 : (ka > kb ? 1 : 0);
    });
  }
  /* 排序用的「下一件事」：最近的将来考试日 > 最近的将来报名起 > 数据里的报名起 */
  function nextKey(c) {
    var es = exams(c), rs = regs(c), i, ex = '', rg = '';
    for (i = 0; i < es.length; i++) if (/^\d{4}-\d{2}-\d{2}$/.test(String(es[i].日)) && es[i].日 >= TODAY && (!ex || es[i].日 < ex)) ex = es[i].日;
    for (i = 0; i < rs.length; i++) if (/^\d{4}-\d{2}-\d{2}$/.test(String(rs[i].起)) && rs[i].起 >= TODAY && (!rg || rs[i].起 < rg)) rg = rs[i].起;
    return ex || rg || (rs[0] && rs[0].起) || '9999-99-99';
  }
  function renderAxis(rows) {
    var st = monthStats(rows), maxN = 1;
    WINDOW.forEach(function (m) { if (st[m].n > maxN) maxN = st[m].n; });
    var html = '';
    for (var i = 0; i < MONTHS; i++) {
      var m = WINDOW[i], s = st[m], wn = mnum(m);
      var isNow = wn === TODAY_N, isPast = wn < TODAY_N;
      var bits = [];
      if (s.reg) bits.push('报 ' + s.reg);
      if (s.exam) bits.push('考 ' + s.exam);
      var cn = (+m.slice(5)) + '月';
      html += '<button type="button" class="axA-cell' + (isNow ? ' now' : '') + (isPast ? ' past' : '') + '"' +
        ' data-m="' + esc(m) + '"' +
        ' title="' + esc(m.slice(0, 4) + '年' + cn + '：' + s.reg + ' 条在报名窗口里 · ' + s.exam + ' 个考试日') + '">' +
        '<span class="m">' + cn + '</span><span class="y">' + m.slice(0, 4) + '</span>' +
        '<span class="tag">' + (bits.length ? bits.join(' · ') : '—') + '</span>' +
        '<span class="bar"><i style="width:' + Math.round(s.n / maxN * 100) + '%"></i></span>' +
        '</button>';
    }
    document.getElementById('tl').innerHTML = html;
    var nowEl = document.getElementById('tlNow');
    if (nowEl) {
      nowEl.textContent = START_AUTO
        ? '· 从 ' + (+START.slice(5)) + ' 月起 ' + MONTHS + ' 个月（每月自动往前滚一格）'
        : '· 窗口从 ' + START + ' 起（手动钉住）';
    }
  }

  /* ── 渲染：筛选（两级：大类 考研/考公/考证 → 类别） ── */
  function renderFilters() {
    var bigCount = {}, catCount = {}, stCount = {}, extN = 0;
    ALL.forEach(function (c) {
      if (isExt(c)) extN++;
      else {
        bigCount[c.大类] = (bigCount[c.大类] || 0) + 1;
        catCount[c.类别] = (catCount[c.类别] || 0) + 1;
      }
      var s = marks[c.id] || '未标记';
      stCount[s] = (stCount[s] || 0) + 1;
    });
    var mainN = ALL.length - extN;              // 「全部」＝主列表（不含专业扩展）
    document.getElementById('bigPills').innerHTML =
      ['全部'].concat(BIGS.map(function (x) { return x.id; })).map(function (id) {
        var n = id === '全部' ? mainN : (bigCount[id] || 0);
        return '<button type="button" class="pill' + (cur.big === id ? ' on' : '') + '" data-big="' + esc(id) + '">' +
          esc(id === '全部' ? '全部' : bigName(id)) + '<span class="n">' + n + '</span></button>';
      }).join('');
    /* 二级只列「考证」下面的细分（考研/考公 已经是一级了，不再重复列） */
    var sub = CATS.filter(function (x) { return x.id !== '考研' && x.id !== '考公'; });
    document.getElementById('catPills').innerHTML =
      ['全部'].concat(sub.map(function (x) { return x.id; })).map(function (id) {
        var n = id === '全部' ? mainN : (id === '专业扩展' ? extN : (catCount[id] || 0));
        return '<button type="button" class="pill' + (cur.cat === id ? ' on' : '') + '" data-cat="' + esc(id) + '">' +
          esc(id === '全部' ? '全部' : catName(id)) + '<span class="n">' + n + '</span></button>';
      }).join('');
    /* 选的是考研/考公 时，二级那一行没意义 → 收起来（同时把二级重置成「全部」） */
    var onlyBig = (cur.big === '考研' || cur.big === '考公');
    if (onlyBig && cur.cat !== '全部') { cur.cat = '全部'; }
    var catRow = document.getElementById('catRow');
    if (catRow) catRow.hidden = onlyBig;
    var sp = ['全部', '未标记'].concat(STATUS).map(function (s) {
      var n = s === '全部' ? ALL.length : (stCount[s] || 0);
      return '<button type="button" class="pill' + (cur.st === s ? ' on' : '') + '" data-st="' + esc(s) + '">' +
        esc(s) + '<span class="n">' + n + '</span></button>';
    }).join('');
    document.getElementById('stPills').innerHTML = sp;
  }

  /* ── 渲染：卡片（按月分组 + A 版信息卡） ── */
  var ORDER = ['语言与出国', '升学与体制内', '财经商科', '计算机与技能', '食品与营养', '专业扩展'];
  /* 考研 / 国考 / 省考 没有「证」→ 第三枚按钮显示「已考」（存进去的还是「已拿」，状态筛选不受影响） */
  function mkLabel(c, s) { return (c.类型 === '考试' && s === '已拿') ? '已考' : s; }
  var SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M12 15V4M8.5 7.2 12 3.7l3.5 3.5M5.5 13v5.5a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V13"/></svg>';

  /* 报名窗口格：优先这一年的窗口（最多两批 + 「等 N 批」）；都在窗口外就退回首两批并标明 */
  function regCellHTML(c) {
    var f = fitOf(c), rs = regs(c);
    var all = f.regs.length ? f.regs : rs;
    if (!all.length) return '全年可报名<span class="dim">（看各考点安排）</span>';
    var list = all.slice(0, 2);
    var out = list.map(function (r, i) {
      return '<span class="' + (i ? 'alt' : 'next') + '"><span class="dates">' + esc(rangeText(r)) + '</span></span>' +
        (r.来源 === '往年规律' ? '<span class="tag">按往年规律</span>' : '');
    }).join('<br>');
    if (all.length > 2) out += '<span class="dim"> 共 ' + all.length + ' 批</span>';
    if (!f.regs.length) out += '<span class="tag">不在这一年</span>';
    return out;
  }
  /* 考试日格：优先这一年内的考期（最多两场 + 「等 N 场」），否则给最近的将来那几场 */
  function examCellHTML(c) {
    var f = fitOf(c), es = exams(c);
    var all = f.exams.length ? f.exams
      : es.filter(function (e) { return e.日 >= TODAY; }).sort(function (a, b) { return a.日 < b.日 ? -1 : (a.日 > b.日 ? 1 : 0); });
    if (!all.length) return c.未公布 ? '待官方公布' : '窗口内无考期';
    var out = all.slice(0, 2).map(function (e, i) {
      var t = cnDate(e.日) + (e.日止 ? '–' + cnDate(e.日止) : '') + (e.类型 ? '（' + e.类型 + '）' : '');
      return '<span class="' + (i ? 'alt' : 'next') + '"><span class="dates">' + esc(t) + '</span></span>';
    }).join('<br>');
    if (all.length > 2) out += '<span class="dim"> 共 ' + all.length + ' 场</span>';
    return out + (c.未公布 ? '<span class="tag">待公布</span>' : '');
  }
  function cardHTML(c) {
    var st = marks[c.id] || '', cd = countdown(c);
    /* 胶囊：考研/考公 显示大类；考证的显示二级类别。简称跟胶囊同名时只留一个，别「考研 考研」 */
    var chip = (c.大类 && c.大类 !== '考证') ? bigName(c.大类) : catName(c.类别);
    return '<article class="card" id="c-' + esc(c.id) + '" data-id="' + esc(c.id) + '">' +
      '<div class="card-top">' +
        '<h2>' + esc(c.名) + (c.简称 && c.简称 !== chip ? '<span class="abbr">' + esc(c.简称) + '</span>' : '') + '</h2>' +
        '<span class="cat">' + esc(chip) + '</span>' +
        (cd.t ? '<span class="cd ' + (cd.hot ? 'hot ' : '') + cd.cls + '">' + esc(cd.t) + '</span>' : '') +
      '</div>' +
      '<div class="facts">' +
        '<div class="f"><span class="k">报名窗口</span><span class="v">' + regCellHTML(c) + '</span></div>' +
        '<div class="f"><span class="k">考试日</span><span class="v">' + examCellHTML(c) + '</span></div>' +
        '<div class="f"><span class="k">费用</span><span class="v">' + esc(c.费用 || '以官网公告为准') + '</span></div>' +
      '</div>' +
      (c.官网 || c.官网名 ? '<div class="card-site">官方网站：' + esc(c.官网名 || domainOf(c.官网)) +
        (c.官网 ? ' <span class="u">' + esc(domainOf(c.官网)) + ' ↗</span>' : '') + '</div>' : '') +
      (c.适合 ? '<p class="card-for"><span class="k">适合</span>' + esc(c.适合) + '</p>' : '') +
      (c.说明 ? '<p class="note"><strong>小鱼：</strong>' + esc(String(c.说明).replace(/^小鱼：/, '')) + '</p>' : '') +
      '<div class="foot">' +
        '<span class="upd">数据截至 ' + esc(c.数据截至 || META.更新时间 || '—') + '</span>' +
        (c.官网 ? '<a class="upd" href="' + esc(c.官网) + '" target="_blank" rel="noopener">官网核对 ↗</a>' : '') +
        '<span class="sts">' + STATUS.map(function (s) {
          return '<button type="button" class="st ' + esc(s) + (st === s ? ' on' : '') + '" data-id="' + esc(c.id) +
            '" data-mk="' + esc(s) + '" aria-pressed="' + (st === s) + '">' + esc(mkLabel(c, s)) + '</button>';
        }).join('') + '</span>' +
        '<button type="button" class="share-btn" data-share="' + esc(c.id) + '" title="分享这张卡片（整张卡 + 二维码）">' + SHARE_ICON + '分享</button>' +
      '</div>' +
      '</article>';
  }
  function renderList(rows) {
    var host = document.getElementById('list');
    var head = '<div class="list-head"><span>共 ' + rows.length + ' 条' +
      (cur.q ? (LOOSE ? '（含说明正文匹配）' : '（按证名/简称匹配）') : '') + '</span><span>' +
      esc(cur.cat === '全部' ? '全部类别' : catName(cur.cat)) + ' · ' + esc(cur.st) + '</span></div>';
    if (!rows.length) {
      host.innerHTML = head + '<p class="empty">这一类暂时没有条目 —— 换一个类别，或点「状态：全部」。</p>';
      return;
    }
    host.innerHTML = head + groupByMonth(rows).map(function (grp) {
      var wait = !!grp.wait;
      return '<section class="grp" id="g-' + esc(grp.ym) + '">' +
        '<div class="grp-side">' +
          '<span class="mo"' + (wait ? ' style="font-size:20px"' : '') + '>' + esc(wait ? '待' : grp.ym.slice(5)) + '</span>' +
          (wait ? '' : '<span class="u">月</span>') +
          '<span class="yr">' + esc(wait ? '窗口内暂无安排' : grp.ym.slice(0, 4)) + '</span>' +
          '<span class="cnt">' + grp.items.length + ' 条</span>' +
        '</div>' +
        '<div class="grp-body">' + grp.items.map(cardHTML).join('') + '</div>' +
        '</section>';
    }).join('');
  }

  /* ── 渲染：说明行 / 页脚 ───────────── */
  function renderMeta() {
    var upd = META.更新时间 || '—';
    var age = /^\d{4}-\d{2}-\d{2}$/.test(upd) ? dayDiff(upd, TODAY) : null;
    var warn = (age !== null && age > 200);
    document.getElementById('meta').innerHTML =
      '时间轴 ' + WINDOW[0] + ' → ' + WINDOW[MONTHS - 1] +
      '　·　数据截至 ' + esc(upd) +
      '　·　共 ' + ALL.length + ' 条　·　已标记 ' + Object.keys(marks).length + ' 项' +
      (warn ? '<br><span class="warn">数据已经 ' + age + ' 天没更新了，报名与考试时间以官网为准。</span>' : '');
    document.getElementById('footSig').textContent = '大学生日历 · 数据截至 ' + upd;
    var cats = CATS.map(function (x) { return x.名; }).join(' / ');
    document.getElementById('footNote').innerHTML =
      '报名与考试时间可能调整，以各证的官方网站为准' +
      (cats ? '　·　类别：' + esc(cats) : '');
  }

  /* ── 交互 ─────────────────────────── */
  function paint() {
    CUR = applyFilters();          // 只算一次，轴与列表共用同一份结果
    renderAxis(CUR); renderFilters(); renderList(CUR); renderMeta(); probe();
  }

  function scrollToCard(id) {
    var el = document.getElementById('c-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: STILL ? 'auto' : 'smooth', block: 'center' });
    el.classList.add('hit');
    setTimeout(function () { el.classList.remove('hit'); }, 1600);
  }
  function toggleMark(id, mk) {
    if (mk && marks[id] === mk) delete marks[id];
    else if (mk) marks[id] = mk;
    else delete marks[id];
    saveMarks();
    paint();
  }
  function bind() {
    document.getElementById('filters').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-big],button[data-cat],button[data-st]');
      if (!b) return;
      if (b.dataset.big) { cur.big = b.dataset.big; cur.cat = '全部'; }   // 换大类就把二级归零，免得出现"空结果"
      if (b.dataset.cat) cur.cat = b.dataset.cat;
      if (b.dataset.st) cur.st = b.dataset.st;
      paint();
    });
    var qEl = document.getElementById('q');
    if (qEl) {
      qEl.addEventListener('input', function () { cur.q = qEl.value.trim(); paint(); });
      // 点筛选重画时别把输入框里的字清掉
      qEl.value = cur.q;
    }
    /* 点月份格 → 滚到那个月的分组（那个月没条目就滚到「窗口内暂无安排」那组） */
    document.getElementById('tl').addEventListener('click', function (e) {
      var cell = e.target.closest('.axA-cell[data-m]');
      if (!cell) return;
      [].forEach.call(document.querySelectorAll('.axA-cell'), function (x) { x.classList.toggle('sel', x === cell); });
      var grp = document.getElementById('g-' + cell.getAttribute('data-m')) || document.getElementById('g-wait');
      if (grp) grp.scrollIntoView({ behavior: STILL ? 'auto' : 'smooth', block: 'start' });
    });
    document.getElementById('list').addEventListener('click', function (e) {
      var sh = e.target.closest('button[data-share]');
      if (sh) {
        var c0 = getCert(sh.getAttribute('data-share'));
        if (c0) openShare(c0);
        return;
      }
      var b = e.target.closest('button[data-mk]');
      if (!b) return;
      toggleMark(b.getAttribute('data-id'), b.getAttribute('data-mk'));
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeShare(); });
    // 键盘：/ 聚焦搜索（暂未做输入框，保留钩子）
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && cur.st !== '全部') { cur.st = '全部'; paint(); }
    });
    // 浏览器本地存储被清掉时重画
    window.addEventListener('storage', function (e) {
      if (e.key !== LSKEY) return;
      try { marks = JSON.parse(e.newValue || '{}') || {}; } catch (err) {}
      paint();
    });
  }

  /* ── 探针（无头验收读它，别删）─────── */
  function getCert(id) {
    for (var i = 0; i < ALL.length; i++) if (ALL[i].id === id) return ALL[i];
    return null;
  }
  function rectOf(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) };
  }
  function probe() {
    var lines = CUR;
    var data = {
      ready: true,
      start: WINDOW[0], end: WINDOW[MONTHS - 1], months: MONTHS,
      today: TODAY, total: ALL.length, shown: lines.length,
      cat: cur.cat, st: cur.st, q: cur.q, loose: LOOSE, marked: Object.keys(marks).length,
      big: cur.big, bigs: BIGS.length, cats: CATS.length,
      deep: DEEP || '', shareBtns: document.querySelectorAll('.share-btn').length,
      theme: document.documentElement.getAttribute('data-theme') || 'day',
      groups: document.querySelectorAll('.grp').length,
      monthCells: document.querySelectorAll('.axA-cell').length,
      ids: lines.map(function (c) { return c.id; })
    };
    /* 分享弹层开着时：卡片与按钮排必须在**同一条中轴**上、都不能被挤出可视区
       （他 2026-09-27 报过「下面的选项会偏移」，这行读数就是盯它的） */
    if (shareBox) {
      var cb = rectOf(shareBox.querySelector('.share-card')), ab = rectOf(shareBox.querySelector('.shade-actions'));
      var vw = document.documentElement.clientWidth;
      data.share = shareBox.getAttribute('data-share-for');
      data.shareQR = !!shareBox.querySelector('.sh-qr svg');
      data.shareCard = cb; data.shareActions = ab;
      data.shareCardMid = cb ? Math.round((cb.l + cb.r) / 2) : null;
      data.shareActionsMid = ab ? Math.round((ab.l + ab.r) / 2) : null;
      /* 判据：卡片与按钮排同轴 **且按钮排不许超出卡片左右边**（光同轴不够——按钮排比卡片宽时
         按钮顶在那一排最左边，看着还是「选项会偏移」，2026-09-27 他连报两次） */
      data.shareFit = !!(cb && ab) && cb.l >= 0 && ab.l >= 0 && ab.r <= vw + 1 && cb.r <= vw + 1 &&
        Math.abs((cb.l + cb.r) / 2 - (ab.l + ab.r) / 2) <= 1 &&
        ab.l >= cb.l - 1 && ab.r <= cb.r + 1;
    }
    document.documentElement.setAttribute('data-kaozheng', JSON.stringify(data));
    window.__kz = {
      data: data,
      setCat: function (id) { cur.cat = id; paint(); },
      setStatus: function (s) { cur.st = s; paint(); },
      mark: function (id, s) { toggleMark(id, s); },
      get: getCert,
      marks: function () { return JSON.parse(JSON.stringify(marks)); },
      clearAll: function () { marks = {}; saveMarks(); paint(); },
      /* 分享：给验收用（开弹层 / 量中轴 / 存图头 / 从存出来的图里采回二维码矩阵） */
      share: function (id) { var c = getCert(id); if (c) openShare(c); },
      closeShare: closeShare,
      shareURL: shareURL,
      sharePNG: function (id, full) {
        var c = getCert(id); if (!c) return null;
        var url = shareURL(c.id), g = null;
        try { g = window.__qr ? window.__qr.encode(url) : null; } catch (e) {}
        var out = shareCanvas(c, g, url), d = out.canvas.toDataURL('image/png');
        var b64 = d.slice(d.indexOf(',') + 1);   // 别把 data:image/png;base64, 前缀当成 PNG 字节
        var o = { url: url, w: out.canvas.width, h: out.canvas.height, head: b64.slice(0, 48), bytes: d.length };
        if (full) o.data = d;                    // 只在要落盘存档时给全量（否则太重）
        return o;
      },
      shareMatrix: function (id) {
        var c = getCert(id); if (!c) return null;
        var url = shareURL(c.id), g = null;
        try { g = window.__qr ? window.__qr.encode(url) : null; } catch (e) {}
        return shareMatrix(c, g, url);
      }
    };
  }

  /* ── 起 ───────────────────────────── */
  /* 从二维码进来的那张卡 id（先读出来，paint 时就能写进探针） */
  function readDeep() {
    var m = /[?&]card=([a-z0-9._-]+)/i.exec(q);
    if (!m) return null;
    return ALL.some(function (x) { return x.id === m[1]; }) ? m[1] : null;
  }
  /* 调试开关 ?share=<id>：一进来就摊开那张卡的分享卡（出图 / 验收用，跟 ?still=1 一类） */
  function readShareDeep() {
    var m = /[?&]share=([a-z0-9._-]+)/i.exec(q);
    if (!m) return null;
    return ALL.some(function (x) { return x.id === m[1]; }) ? m[1] : null;
  }
  function boot() {
    if (STILL) document.documentElement.setAttribute('data-nofade', '');
    DEEP = readDeep();
    var wantShare = readShareDeep();
    if (PROBE_ONLY) { CUR = applyFilters(); probe(); return; }
    if (!document.documentElement.classList.contains('in')) {
      requestAnimationFrame(function () { document.documentElement.classList.add('in'); });
    }
    bind();
    paint();
    // 吸顶：滚动时钉住时间轴条（只在需要时跑，rAF 节流）
    pinCache(document.getElementById('tlbar'));
    window.addEventListener('scroll', onScroll, { passive: true });
    var rzT = 0;
    window.addEventListener('resize', function () {
      clearTimeout(rzT);
      rzT = setTimeout(function () { pin.on = false; pinCache(document.getElementById('tlbar')); pinTick(); }, 150);
    });
    pinTick();
    // 深链：滚到那张卡并标出来
    if (DEEP) {
      var el = document.getElementById('c-' + DEEP);
      if (el) {
        el.classList.add('hit');
        el.scrollIntoView({ behavior: STILL ? 'auto' : 'smooth', block: 'center' });
        setTimeout(function () { el.classList.remove('hit'); }, 4200);
      }
      // 把 ?card= 从地址栏收掉（用 replaceState 而不是刷新：刷新会丢掉刚打的标记）
      try { if (history.replaceState) history.replaceState(null, '', location.pathname + (location.hash || '')); } catch (e) {}
    }
    if (wantShare) { var cShare = getCert(wantShare); if (cShare) openShare(cShare); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
