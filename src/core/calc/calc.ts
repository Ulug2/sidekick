// Exact math for the "calculate" tool: math.js (numbers, matrices, units, statistics,
// symbolic derivative/simplify) plus nerdamer (integrals, limits, solving, factoring).
// Neither library uses eval, so this runs inside the extension's strict security policy.

// The calculator behind the "calculate" tool. Internals work on math.js/nerdamer expression
// nodes, which are untyped, so they're `any` here; the public API below is typed.
export const calcEngine = (() => {
  let ready: Promise<void> | null = null;

  function load(): Promise<void> {
    ready ||= (async () => {
      if (!window.math) await loadScript("vendor/math.js");
      if (!window.nerdamer) await loadScript("vendor/nerdamer.js");
      install(window.math, window.nerdamer);
    })();
    return ready;
  }

  function loadScript(path?: any) {
    return new Promise((resolve?: any, reject?: any) => {
      const s = document.createElement("script");
      s.src = typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Couldn't load ${path}`));
      document.head.appendChild(s);
    });
  }

  // User-defined functions in the current calculation, e.g. f(x, y) = 4x^2 y^2 + 10x^2 + 9y^2,
  // so symbolic helpers can expand diff(f(x, y), x).
  let defs: Record<string, any> = {};
  let scope = new Map();

  function install(math?: any, nerdamer?: any) {
    const numericSum = math.sum;
    // Turns a raw (unevaluated) argument into plain text for nerdamer: user functions are
    // expanded, known numeric variables substituted, except the variable being worked on.
    const toText = (node?: any, keep: any = []) => {
      const expanded = node.transform(function expand(n?: any) {
        if (n.isFunctionNode && defs[n.fn?.name]) {
          const { params, body } = defs[n.fn.name];
          const args = n.args.map((a: any) => a.transform(expand));
          return body.transform((m: any) => (m.isSymbolNode && params.includes(m.name) ? args[params.indexOf(m.name)] : m));
        }
        if (n.isSymbolNode && !keep.includes(n.name) && scope.has(n.name) && typeof scope.get(n.name) === "number") {
          return new math.ConstantNode(scope.get(n.name));
        }
        return n;
      });
      return expanded.toString({ implicit: "show" });
    };
    // "a = b" inside solve() is parsed as a == b (see fixEquals); turn it back into an equation.
    const eqText = (node?: any, keep?: any) => {
      if (node.isAssignmentNode) return `${toText(node.object, keep)}=${toText(node.value, keep)}`;
      if (node.isOperatorNode && node.fn === "equal") return `${toText(node.args[0], keep)}=${toText(node.args[1], keep)}`;
      return toText(node, keep);
    };
    const varName = (node: any) => (node.isSymbolNode ? node.name : String(node.evaluate?.(scope) ?? node));
    const valueOf = (node: any) => {
      if (node.isSymbolNode && /^(inf|infinity|Infinity)$/.test(node.name)) return "Infinity";
      if (node.isUnaryMinusNode && node.args[0].isSymbolNode && /^(inf|infinity|Infinity)$/.test(node.args[0].name)) return "-Infinity";
      return toText(node);
    };
    const out = (e: any) => {
      const t = typeof e === "string" ? e : e.text();
      return new SymbolicResult(t);
    };

    // ---------- numeric methods ----------
    // For anything the exact algebra engine can't do (square roots, trig, logs, messy systems).
    // math.js compiles expressions without eval, so this is safe in the extension.
    const CONSTANTS = new Set(["pi", "e", "i", "E", "PI", "Infinity", "inf", "infinity", "NaN", "true", "false", "phi", "tau"]);
    const freeVars = (nodes: any) => {
      const set = new Set();
      for (const node of nodes) {
        node.traverse((n?: any, path?: any, parent?: any) => {
          if (!n.isSymbolNode || CONSTANTS.has(n.name)) return;
          if (parent?.isFunctionNode && path === "fn") return;
          if (scope.has(n.name) && typeof scope.get(n.name) !== "function") return;
          if (defs[n.name] || typeof math[n.name] === "function") return;
          set.add(n.name);
        });
      }
      return [...set].sort();
    };
    const sub = (a?: any, b?: any) => new math.OperatorNode("-", "subtract", [a, b]);
    const asResidual = (node: any) => {
      if (node.isAssignmentNode) return sub(node.object, node.value);
      if (node.isOperatorNode && node.fn === "equal") return sub(node.args[0], node.args[1]);
      return node;
    };
    const toNumber = (r: any) => (typeof r === "number" ? r : r && typeof r.re === "number" && Math.abs(r.im || 0) < 1e-12 ? r.re : NaN);
    // Compiles an expression into f([values]) → number for the given variables.
    const compileFn = (node?: any, vars?: any) => {
      const code = math.compile(toText(node, vars));
      return (vals: any) => {
        const sc = new Map(scope);
        vars.forEach((v?: any, k?: any) => sc.set(v, vals[k]));
        try { return toNumber(code.evaluate(sc)); } catch { return NaN; }
      };
    };
    const varList = (node: any) => (node.isArrayNode ? node.items.map(varName) : [varName(node)]);
    const numList = (node: any) => (node ? (node.isArrayNode ? node.items.map((n: any) => Number(n.evaluate(scope))) : [Number(node.evaluate(scope))]) : null);
    const fmt = (v: any) => math.format(v, { precision: 12 });

    function nelderMead(f?: any, x0?: any, { iters = 6000 }: any = {}) {
      const n = x0.length;
      const F = (p: any) => { const v = f(p); return Number.isFinite(v) ? v : Infinity; };
      let pts = [x0.slice()];
      for (let k = 0; k < n; k++) {
        const p = x0.slice();
        p[k] += Math.abs(p[k]) > 1e-3 ? 0.2 * Math.abs(p[k]) : 0.5;
        pts.push(p);
      }
      let vals = pts.map(F);
      for (let it = 0; it < iters; it++) {
        const idx = vals.map((v?: any, k?: any) => k).sort((a?: any, b?: any) => vals[a] - vals[b]);
        pts = idx.map((k: any) => pts[k]); vals = idx.map((k: any) => vals[k]);
        const spread = Math.max(...pts.slice(1).map((p: any) => Math.max(...p.map((x?: any, k?: any) => Math.abs(x - pts[0][k])))));
        if (spread < 1e-13 * (1 + Math.max(...pts[0].map(Math.abs))) && Math.abs(vals[n] - vals[0]) < 1e-15 * (1 + Math.abs(vals[0]))) break;
        const c = pts[0].map((_?: any, k?: any) => pts.slice(0, n).reduce((s?: any, p?: any) => s + p[k], 0) / n);
        const along = (t: any) => c.map((ck?: any, k?: any) => ck + t * (pts[n][k] - ck));
        const r = along(-1), fr = F(r);
        if (fr < vals[0]) {
          const e = along(-2), fe = F(e);
          if (fe < fr) { pts[n] = e; vals[n] = fe; } else { pts[n] = r; vals[n] = fr; }
        } else if (fr < vals[n - 1]) {
          pts[n] = r; vals[n] = fr;
        } else {
          const ct = fr < vals[n] ? along(-0.5) : along(0.5), fc = F(ct);
          if (fc < Math.min(fr, vals[n])) { pts[n] = ct; vals[n] = fc; }
          else {
            for (let k = 1; k <= n; k++) { pts[k] = pts[k].map((x?: any, j?: any) => pts[0][j] + 0.5 * (x - pts[0][j])); vals[k] = F(pts[k]); }
          }
        }
      }
      const best = vals.indexOf(Math.min(...vals));
      return { x: pts[best], value: vals[best] };
    }

    // Multi-start Nelder–Mead with restarts for precision.
    function optimize(f?: any, vars?: any, guess?: any, bounds?: any) {
      const inBounds = (p: any) => !bounds || p.every((x?: any, k?: any) => !bounds[k] || (x >= bounds[k][0] && x <= bounds[k][1]));
      const g = (p: any) => (inBounds(p) ? f(p) : Infinity);
      const starts = [];
      if (guess) starts.push(guess);
      const seeds = [0.5, 1, 2, 5, -1, 10, 0.1];
      for (const sd of seeds) starts.push(vars.map((_?: any, k?: any) => (bounds?.[k] ? (bounds[k][0] + bounds[k][1]) / 2 : sd * (k % 2 ? 1 : 1.3))));
      // With bounds and few variables, a coarse grid finds the right basin (global minimum).
      if (bounds && bounds.every(Boolean) && vars.length <= 2) {
        const N = vars.length === 1 ? 400 : 60;
        const grid = [];
        const axis = (k: any) => Array.from({ length: N + 1 }, (_?: any, i?: any) => bounds[k][0] + ((bounds[k][1] - bounds[k][0]) * i) / N);
        if (vars.length === 1) for (const a of axis(0)) grid.push([a]);
        else for (const a of axis(0)) for (const b of axis(1)) grid.push([a, b]);
        grid.map((p: any) => [p, g(p)]).filter(([, v]: any) => Number.isFinite(v)).sort((a?: any, b?: any) => a[1] - b[1]).slice(0, 4).forEach(([p]: any) => starts.unshift(p));
      }
      let best = null;
      for (const st of starts) {
        if (!Number.isFinite(g(st))) continue;
        let r = nelderMead(g, st);
        for (let k = 0; k < 4; k++) r = nelderMead(g, r.x); // restarts sharpen the result
        if (!best || r.value < best.value - 1e-12) best = r;
      }
      if (!best || !Number.isFinite(best.value)) throw new Error("Couldn't find a minimum. Try minimize with a starting guess, e.g. minimize(f, [x, y], [1, 1]).");
      return best;
    }

    // Newton's method with a numeric Jacobian and damping, from many starting points.
    function newtonSystem(Fs?: any, vars?: any, guesses?: any) {
      const n = vars.length;
      const F = (x: any) => Fs.map((f: any) => f(x));
      const norm = (v: any) => Math.sqrt(v.reduce((s?: any, a?: any) => s + a * a, 0));
      const run = (x0: any) => {
        let x = x0.slice();
        for (let it = 0; it < 200; it++) {
          const fx = F(x);
          if (fx.some((v: any) => !Number.isFinite(v))) return null;
          const nf = norm(fx);
          if (nf < 1e-13) return x;
          const J = fx.map(() => new Array(n));
          for (let j = 0; j < n; j++) {
            const h = 1e-7 * Math.max(1, Math.abs(x[j]));
            const xp = x.slice(); xp[j] += h;
            const fp = F(xp);
            for (let i = 0; i < Fs.length; i++) J[i][j] = (fp[i] - fx[i]) / h;
          }
          let dx;
          try { dx = math.flatten(math.lusolve(J, fx.map((v: any) => -v))).map(Number); } catch { return null; }
          let t = 1, moved = false;
          for (let k = 0; k < 30; k++, t /= 2) {
            const xn = x.map((xi?: any, j?: any) => xi + t * dx[j]);
            const fn = F(xn);
            if (fn.every(Number.isFinite) && norm(fn) < nf) { x = xn; moved = true; break; }
          }
          if (!moved) return nf < 1e-9 ? x : null;
        }
        return norm(F(x)) < 1e-9 ? x : null;
      };
      const starts = guesses ? [guesses] : [];
      const seeds = [0.5, 1, 2, 3, 5, 10, -1, -2, -5, 0.1, 0];
      for (const a of seeds) for (const b of [1, -1, 2]) starts.push(vars.map((_?: any, k?: any) => (k % 2 ? a * b : a)));
      const sols: any[] = [];
      for (const st of starts) {
        const x = run(st);
        if (x && !sols.some((s: any) => s.every((v?: any, k?: any) => Math.abs(v - x[k]) < 1e-7 * (1 + Math.abs(v))))) sols.push(x);
      }
      return sols;
    }

    // Real roots of one equation: scan for sign changes, refine, plus Newton from a guess.
    function rootsOf(f?: any, guess?: any, range: any = [-100, 100]) {
      const roots: any[] = [];
      const add = (r: any) => { if (Number.isFinite(r) && Math.abs(f(r)) < 1e-8 * (1 + Math.abs(r)) && !roots.some((x: any) => Math.abs(x - r) < 1e-9 * (1 + Math.abs(r)))) roots.push(r); };
      const bisect = (a?: any, b?: any) => {
        let fa = f(a);
        for (let k = 0; k < 200; k++) {
          const m = (a + b) / 2, fm = f(m);
          if (!Number.isFinite(fm)) return NaN;
          if (fa * fm <= 0) b = m; else { a = m; fa = fm; }
          if (Math.abs(b - a) < 1e-15 * (1 + Math.abs(a))) break;
        }
        return (a + b) / 2;
      };
      const N = 8000, [lo, hi] = range;
      let px = lo, pf = f(px);
      for (let k = 1; k <= N; k++) {
        const x = lo + ((hi - lo) * k) / N, fx = f(x);
        if (fx === 0) add(x);
        else if (Number.isFinite(pf) && Number.isFinite(fx) && pf * fx < 0) add(bisect(px, x));
        px = x; pf = fx;
      }
      for (const st of [guess, 0.5, 1, -1, 5].filter((v: any) => v !== undefined && v !== null)) {
        const sols = newtonSystem([(v: any) => f(v[0])], ["x"], [st]);
        sols.forEach((s: any) => add(s[0]));
      }
      return roots.sort((a?: any, b?: any) => a - b);
    }

    const numericSystem = (eqNodes?: any, vars?: any, guesses?: any) => {
      const res = eqNodes.map(asResidual);
      vars ||= freeVars(res);
      if (res.length !== vars.length) throw new Error(`Numeric solving needs as many equations as unknowns (${res.length} equations, unknowns: ${vars.join(", ") || "none"}).`);
      const sols = newtonSystem(res.map((r: any) => compileFn(r, vars)), vars, guesses);
      if (!sols.length) throw new Error("No real solution found numerically. Try nsolveSystem with a starting guess.");
      return new SymbolicResult(`numeric: ` + sols.map((s: any) => `{${vars.map((v?: any, k?: any) => `${v} = ${fmt(s[k])}`, null).join(", ")}}`).join(", "));
    };

    const fns = {
      diff(args?: any) {
        const [f, v, n] = args;
        const x = v ? varName(v) : "x";
        let r = nerdamer(toText(f, [x]));
        for (let i = 0; i < (n ? Number(n.evaluate(scope)) : 1); i++) r = nerdamer.diff(r, x);
        return out(r);
      },
      integrate(args?: any) {
        const [f, v] = args;
        const x = v ? varName(v) : "x";
        const r = nerdamer.integrate(toText(f, [x]), x);
        if (/integrate\(/.test(r.text())) throw new Error("No closed-form antiderivative found. Use defint(f, x, a, b) for a numeric definite integral.");
        return out(r);
      },
      defint(args?: any) {
        const [f, v, a, b] = args;
        const x = varName(v);
        // Exact first (antiderivative evaluated at the bounds), numeric Simpson as fallback.
        try {
          const F = nerdamer.integrate(toText(f, [x]), x);
          if (!/integrate\(/.test(F.text())) {
            const at = (bound: any) => nerdamer(F.text(), { [x]: valueOf(bound) });
            const exact = nerdamer(`(${at(b).text()})-(${at(a).text()})`);
            const n = math.evaluate(exact.text().replace(/\bpi\b/g, "pi"));
            if (Number.isFinite(n)) return new SymbolicResult(exact.text(), n);
          }
        } catch {}
        const r = nerdamer.defint(toText(f, [x]), x, valueOf(a), valueOf(b));
        return out(r);
      },
      limit(args?: any) {
        const [f, v, to] = args;
        const x = varName(v);
        return out(nerdamer.limit(toText(f, [x]), x, valueOf(to)));
      },
      solve(args?: any) {
        const [f, v] = args;
        const x = v ? varName(v) : "x";
        try {
          const r = nerdamer.solve(eqText(f, [x]), x);
          const t = r.text ? r.text() : String(r);
          if (t && t !== "{}" && t !== "[]" && !new RegExp(`\\b${x}\\b`).test(t)) return out(r);
        } catch {}
        // Exact algebra couldn't do it: find the real roots numerically.
        const g = compileFn(asResidual(f), [x]);
        const rs = rootsOf((val: any) => g([val]));
        if (!rs.length) throw new Error(`No real solution found for ${x} in [-100, 100]. Try nsolve with a starting guess.`);
        return new SymbolicResult(`numeric: {${rs.map(fmt).join(", ")}}`, null);
      },
      solveSystem(args?: any) {
        const eqs = args[0].isArrayNode ? args[0].items : args;
        try {
          const r = nerdamer.solveSystem(eqs.map((e: any) => eqText(e))).toString();
          if (r && r !== "[]" && !/solve|undefined/i.test(r)) return out(r);
        } catch {}
        return numericSystem(eqs);
      },
      // nsolve(equation, x[, guess][, [lo, hi]]): real roots of one equation, numerically.
      nsolve(args?: any) {
        const [f, v, g, range] = args;
        const x = varName(v);
        const fn = compileFn(asResidual(f), [x]);
        const rs = rootsOf((val: any) => fn([val]), g ? Number(g.evaluate(scope)) : undefined, range ? numList(range) : undefined);
        if (!rs.length) throw new Error(`No real root found. Give a starting guess or a range: nsolve(eq, ${x}, guess, [lo, hi]).`);
        return new SymbolicResult(`${x} = ${rs.map(fmt).join(", ")}`, null);
      },
      // nsolveSystem([eq1, eq2], [x, y][, [x0, y0]])
      nsolveSystem(args?: any) {
        const [eqs, vs, g] = args;
        return numericSystem(eqs.isArrayNode ? eqs.items : [eqs], vs ? varList(vs) : null, numList(g));
      },
      // minimize(f, [x, y][, [x0, y0]][, [[xlo, xhi], [ylo, yhi]]])
      minimize(args?: any) {
        const [f, vs, g, b] = args;
        const vars = vs ? varList(vs) : freeVars([f]);
        const bounds = b ? b.items.map((it: any) => (it.isArrayNode ? it.items.map((n: any) => Number(n.evaluate(scope))) : null)) : null;
        const r = optimize(compileFn(f, vars), vars, numList(g), bounds);
        return new SymbolicResult(`minimum ${fmt(r.value)} at ${vars.map((v?: any, k?: any) => `${v} = ${fmt(r.x[k])}`, null).join(", ")}`);
      },
      maximize(args?: any) {
        const [f, vs, g, b] = args;
        const vars = vs ? varList(vs) : freeVars([f]);
        const bounds = b ? b.items.map((it: any) => (it.isArrayNode ? it.items.map((n: any) => Number(n.evaluate(scope))) : null)) : null;
        const fn = compileFn(f, vars);
        const r = optimize((p: any) => -fn(p), vars, numList(g), bounds);
        return new SymbolicResult(`maximum ${fmt(-r.value)} at ${vars.map((v?: any, k?: any) => `${v} = ${fmt(r.x[k])}`, null).join(", ")}`);
      },
      // scanCurve(f, g = c, x, y[, [xlo, xhi]]): walks along the curve g = c (solving for y at many
      // x values, from near 0 out to ±10000) and reports where f is largest and smallest, and
      // whether each is actually reached or only approached far out along the curve. Lagrange
      // multipliers only find candidates; on an unbounded curve (x^3 + y^3 = 54, xy = 1) an
      // extreme that's only approached does not exist (DNE).
      scanCurve(args?: any) {
        const [f, eq, xv, yv, range] = args;
        if (!f || !eq || !xv || !yv) throw new Error("Use scanCurve(f, g = c, x, y), e.g. scanCurve(exp(x*y), x^3 + y^3 = 54, x, y).");
        const x = varName(xv), y = varName(yv);
        const F = compileFn(f, [x, y]);
        const G = compileFn(asResidual(eq), [x, y]);
        const [lo, hi] = range ? numList(range) : [-1e4, 1e4];
        const xs = new Set();
        for (let i = -400; i <= 400; i++) xs.add(+(i * 0.025).toFixed(4)); // [-10, 10], fine
        for (let k = 1; k <= 80; k++) { const v = 10 * Math.pow(Math.max(Math.abs(lo), Math.abs(hi)) / 10, k / 80); xs.add(v); xs.add(-v); }
        const pts = [];
        const ysAt = (xx: any) => {
          const g = (yy: any) => G([xx, yy]);
          const R = Math.max(50, 4 * Math.abs(xx)), N = 1200, roots = [];
          let py = -R, pg = g(py);
          for (let k = 1; k <= N; k++) {
            const yy = -R + (2 * R * k) / N, gy = g(yy);
            if (gy === 0) roots.push(yy);
            else if (Number.isFinite(pg) && Number.isFinite(gy) && pg * gy < 0) {
              let a = py, b = yy, fa = pg;
              for (let it = 0; it < 80; it++) { const m = (a + b) / 2, fm = g(m); if (fa * fm <= 0) b = m; else { a = m; fa = fm; } }
              roots.push((a + b) / 2);
            }
            py = yy; pg = gy;
          }
          return roots;
        };
        const sorted: any[] = [...xs].filter((v: any) => v >= lo && v <= hi).sort((a?: any, b?: any) => a - b);
        for (const xx of sorted) for (const yy of ysAt(xx)) { const v = F([xx, yy]); if (Number.isFinite(v)) pts.push({ x: xx, y: yy, v }); }
        if (!pts.length) throw new Error("Found no points on that curve in the scanned range. Check the equation, or give a range: scanCurve(f, g = c, x, y, [xlo, xhi]).");
        // Refine the best and worst points locally (the grid is coarse).
        const farX = Math.max(...pts.map((p: any) => Math.abs(p.x)));
        const reach = (p: any) => (Math.abs(p.x) >= 0.5 * farX && farX > 20 ? "far" : "inside");
        const refine = (p?: any, better?: any) => {
          let best = p;
          for (let h = 0.02; h > 1e-7; h /= 2) {
            for (const dx of [-h, h]) for (const yy of ysAt(best.x + dx).filter((v: any) => Math.abs(v - best.y) < 1)) {
              const v = F([best.x + dx, yy]);
              if (Number.isFinite(v) && better(v, best.v)) best = { x: best.x + dx, y: yy, v };
            }
          }
          return best;
        };
        let mx = pts.reduce((a?: any, b?: any) => (b.v > a.v ? b : a)), mn = pts.reduce((a?: any, b?: any) => (b.v < a.v ? b : a));
        if (reach(mx) === "inside") mx = refine(mx, (a?: any, b?: any) => a > b);
        if (reach(mn) === "inside") mn = refine(mn, (a?: any, b?: any) => a < b);
        const ends = pts.filter((p: any) => Math.abs(p.x) >= 0.9 * farX);
        const endVals = ends.map((p: any) => p.v);
        const describe = (p?: any, kind?: any) => {
          if (reach(p) === "far") return `${kind} f ≈ ${fmt(p.v)} only far out along the curve (x = ${fmt(p.x)}): f keeps getting ${kind === "largest" ? "larger" : "smaller"} toward the ends and never settles → the ${kind === "largest" ? "maximum" : "minimum"} is NOT attained: answer DNE (unless the problem restricts the region)`;
          return `${kind} f = ${fmt(p.v)} at ${x} = ${fmt(p.x)}, ${y} = ${fmt(p.y)} (reached at that point)`;
        };
        const lines = [
          `scanned ${pts.length} points on the curve for ${x} in [${fmt(Math.max(lo, sorted[0]))}, ${fmt(Math.min(hi, sorted.at(-1)))}]`,
          describe(mx, "largest"),
          describe(mn, "smallest")
        ];
        if (endVals.length && farX > 20) lines.push(`far out along the curve, f is between ${fmt(Math.min(...endVals))} and ${fmt(Math.max(...endVals))}`);
        return new SymbolicResult(lines.join("; "), null);
      },
      factor(args?: any) { return out(nerdamer.factor(toText(args[0]))); },
      expand(args?: any) { return out(nerdamer(`expand(${toText(args[0])})`)); },
      partfrac(args?: any) { return out(nerdamer(`partfrac(${toText(args[0])}, ${args[1] ? varName(args[1]) : "x"})`)); },
      sum(args?: any) {
        // sum(expr, k, from, to): symbolic/exact series sum
        if (args.length === 4) {
          const [f, k, a, b] = args;
          return out(nerdamer(`sum(${toText(f, [varName(k)])}, ${varName(k)}, ${valueOf(a)}, ${valueOf(b)})`));
        }
        return numericSum(...args.map((a: any) => a.evaluate(scope)));
      }
    };

    // Symbolic helpers receive raw syntax, so diff(x^3 sin(x), x) needs no quotes.
    const imports: Record<string, any> = {};
    for (const [name, fn] of Object.entries(fns)) {
      const wrapped = function (args?: any) { return fn(args); };
      wrapped.rawArgs = true;
      imports[name] = wrapped;
    }
    math.import(imports, { override: true });

    class SymbolicResult {
      text: any;
      approx: any;
      constructor(text?: any, approx?: any) {
        this.text = text;
        this.approx = approx;
        if (approx === undefined) {
          try {
            const n = math.evaluate(text);
            if (typeof n === "number" && Number.isFinite(n)) this.approx = n;
          } catch {}
        }
      }
      toString() { return this.text; }
    }
    window.SymbolicResult = SymbolicResult;
  }

  function format(v?: any) {
    const m = window.math;
    if (v instanceof window.SymbolicResult) {
      const exact = v.text.replace(/\*/g, "·");
      return v.approx != null && String(v.approx) !== v.text ? `${exact}  ≈ ${m.format(v.approx, { precision: 12 })}` : exact;
    }
    if (typeof v === "function") return `function ${v.syntax || ""}`.trim();
    if (v && v.isResultSet) return v.entries.map(format).join("; ");
    return m.format(v, { precision: 14 });
  }

  // Inside parentheses/brackets a single "=" can only mean an equation, so make it "==".
  function fixEquals(line?: any) {
    let depth = 0, out = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if ("([".includes(c)) depth++;
      if (")]".includes(c)) depth--;
      if (c === "=" && depth > 0 && !"=<>!".includes(line[i - 1]) && line[i + 1] !== "=") out += "==";
      else out += c;
    }
    return out;
  }

  // "x (20 - 2x)" parses as calling a function named x. When the name isn't a known function,
  // treat it as multiplication, which is what people mean.
  function fixImplicitCalls(node?: any) {
    const m = window.math;
    const unknownCall = (n: any) => n?.isFunctionNode && n.fn?.isSymbolNode && n.args.length === 1 &&
      !(typeof m[n.fn.name] === "function" || defs[n.fn.name] || typeof scope.get(n.fn.name) === "function");
    return node.transform(function fix(n?: any) {
      // x (20 - 2x)^2 means x · (20 - 2x)^2: the power belongs to the parentheses.
      if (n.isOperatorNode && n.fn === "pow" && unknownCall(n.args[0])) {
        const call = n.args[0];
        return new m.OperatorNode("*", "multiply", [
          new m.SymbolNode(call.fn.name),
          new m.OperatorNode("^", "pow", [new m.ParenthesisNode(call.args[0].transform(fix)), n.args[1].transform(fix)])
        ]);
      }
      if (unknownCall(n)) return new m.OperatorNode("*", "multiply", [new m.SymbolNode(n.fn.name), new m.ParenthesisNode(n.args[0].transform(fix))]);
      return n;
    });
  }

  // Evaluates lines in order, sharing variables and functions. Returns readable text.
  async function run(lines: string[]): Promise<string> {
    await load();
    const m = window.math;
    defs = {};
    scope = new Map();
    const results = [];
    for (const raw of lines.flatMap((l: any) => String(l).split(/\n|;(?![^\[]*\])/)).map((l: any) => l.trim()).filter(Boolean)) {
      if (raw.length > 2000) { results.push(`${raw.slice(0, 40)}… ✗ too long`); continue; }
      try {
        const node = fixImplicitCalls(m.parse(fixEquals(raw)));
        if (node.isFunctionAssignmentNode) defs[node.name] = { params: node.params, body: node.expr };
        const v = node.compile().evaluate(scope);
        if (node.isAssignmentNode && node.object?.isSymbolNode && typeof v === "number") scope.set(node.object.name, v);
        results.push(`${raw}  →  ${format(v)}`);
      } catch (err: any) {
        results.push(`${raw}  ✗ ${String(err.message || err).slice(0, 200)}`);
      }
    }
    return results.join("\n");
  }

  // Pretty math from models (√, ², ≤, −, ·) → math.js syntax.
  function normalize(expr: string): string {
    return String(expr)
      .replace(/[−–]/g, "-").replace(/[·×]/g, "*").replace(/÷/g, "/")
      .replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/≠/g, "!=").replace(/π/g, "pi")
      .replace(/²/g, "^2").replace(/³/g, "^3")
      .replace(/√\s*\(/g, "sqrt(").replace(/√\s*([\w.]+)/g, "sqrt($1)")
      .replace(/\\cdot|\\times/g, "*").replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)").replace(/\\left|\\right|\\,/g, "")
      .trim();
  }

  // Splits "lhs = rhs" at a top-level single "=" (not <=, >=, ==, !=).
  function splitEquation(expr?: any) {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
      const c = expr[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "=" && depth === 0 && !"=<>!".includes(expr[i - 1]) && expr[i + 1] !== "=") return [expr.slice(0, i), expr.slice(i + 1)];
    }
    return null;
  }

  // Evaluates one expression at given variable values, e.g. evaluate("40 sqrt(x^2+4)", { x: 4.13 }).
  // An equation "a = b" returns its residual a − b. Inequalities return true/false.
  // Used to compare candidate answers with code instead of trusting a model's verdict.
  async function evaluate(expr: string, values: Record<string, unknown> = {}): Promise<any> {
    await load();
    const m = window.math;
    defs = {};
    scope = new Map(Object.entries(values));
    const e = normalize(expr);
    const eq = splitEquation(e);
    const parse = (t: any) => fixImplicitCalls(m.parse(fixEquals(t)));
    const node = eq ? new m.OperatorNode("-", "subtract", [new m.ParenthesisNode(parse(eq[0])), new m.ParenthesisNode(parse(eq[1]))]) : parse(e);
    const v = node.compile().evaluate(scope);
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v;
    if (v && typeof v.re === "number" && Math.abs(v.im || 0) < 1e-12) return v.re;
    if (v && typeof v.toNumber === "function") return v.toNumber();
    throw new Error(`Not a number: ${expr}`);
  }

  // Variable names an expression uses (excluding known functions and constants).
  async function variables(expr: string): Promise<string[]> {
    await load();
    const m = window.math;
    const e = normalize(expr);
    const eq = splitEquation(e);
    const nodes = (eq ? eq : [e]).map((t: any) => fixImplicitCalls(m.parse(fixEquals(t))));
    const set = new Set<string>();
    for (const node of nodes) node.traverse((n?: any, path?: any, parent?: any) => {
      if (!n.isSymbolNode) return;
      if (parent?.isFunctionNode && path === "fn") return;
      if (/^(pi|e|E|PI|i|Infinity|inf|phi|tau|true|false)$/.test(n.name) || typeof m[n.name] === "function") return;
      set.add(n.name);
    });
    return [...set].sort();
  }

  return { run, load, evaluate, variables, normalize };
})();
