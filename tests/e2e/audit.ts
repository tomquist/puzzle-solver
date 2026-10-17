/**
 * Programmatic mobile-friendliness audit of the current page state. Run it after every screen of a
 * flow; it returns a list of violations (empty = pass).
 *
 * Rules
 * - overflow:   no horizontal page scroll; no rendered element extends past the viewport width
 *               (elements clipped by an overflow container are measured by their visible part).
 * - tap-target: visible interactive elements have a ≥ 44 × 44 CSS px hit area (box, or box grown
 *               by an absolutely positioned ::before/::after).
 * - input-font: input/select/textarea font-size ≥ 16 px (iOS Safari zooms into smaller fields).
 * - small-text: no visible text below 12 px (SVG text measured in screen px).
 * - covered:    each enabled primary action (.btn-primary) can be scrolled into view and the element
 *               at its centre is the action itself (not a fixed header, tab bar, snackbar or sheet).
 *               With a dialog open only the dialog's actions are checked.
 * - safe-area:  fixed/sticky bars (and open dialogs' footers) have a CSS rule using
 *               env(safe-area-inset-*).
 * - viewport:   <meta name=viewport> has width=device-width and does not disable zooming.
 *
 * Allow-list (documented exceptions)
 * - Text links inside a sentence (`p a`, `li a`) – WCAG 2.5.8 "inline" exception; the sentence's
 *   line height determines their size.
 * - Disabled primary buttons are skipped by the `covered` rule (pointer-events: none – not
 *   actionable).
 * - Visually-hidden file inputs are skipped; their visible <label class="btn"> is checked instead.
 */
import type { Page } from '@playwright/test';

export interface Violation {
  rule: 'overflow' | 'tap-target' | 'input-font' | 'small-text' | 'covered' | 'safe-area' | 'viewport';
  element: string;
  detail: string;
}

export const MIN_TARGET = 44;
export const MIN_TEXT = 12;
export const MIN_INPUT_FONT = 16;

export async function auditPage(page: Page): Promise<Violation[]> {
  return page.evaluate(
    ({ MIN_TARGET, MIN_TEXT, MIN_INPUT_FONT }) => {
      type V = { rule: Violation['rule']; element: string; detail: string };
      const out: V[] = [];
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const eps = 0.5;

      const describe = (el: Element): string => {
        const tag = el.tagName.toLowerCase();
        const testId = el.getAttribute('data-testid');
        const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 3).join('.') : el.getAttribute('class')?.split(/\s+/).slice(0, 2).join('.') ?? '';
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32);
        return `${tag}${testId ? `[data-testid=${testId}]` : ''}${cls ? `.${cls}` : ''}${label ? ` "${label}"` : ''}`;
      };

      const rendered = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        for (let a: Element | null = el; a; a = a.parentElement) {
          if (Number(getComputedStyle(a).opacity) === 0) return false;
        }
        return true;
      };

      /** The element's rectangle clipped by every overflow-clipping ancestor (null = fully clipped). */
      const visibleRect = (el: Element): { left: number; top: number; right: number; bottom: number } | null => {
        const r = el.getBoundingClientRect();
        let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
        for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
          const cs = getComputedStyle(a);
          const clipX = cs.overflowX !== 'visible';
          const clipY = cs.overflowY !== 'visible';
          if (!clipX && !clipY) continue;
          const ar = a.getBoundingClientRect();
          if (clipX) {
            left = Math.max(left, ar.left);
            right = Math.min(right, ar.right);
          }
          if (clipY) {
            top = Math.max(top, ar.top);
            bottom = Math.min(bottom, ar.bottom);
          }
          if (right - left <= 0 || bottom - top <= 0) return null;
        }
        return { left, top, right, bottom };
      };

      // --- viewport meta
      const meta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
      const kv = Object.fromEntries(meta.split(',').map((p) => p.trim().split('=').map((s) => s.trim().toLowerCase())));
      if (kv['width'] !== 'device-width') out.push({ rule: 'viewport', element: 'meta[name=viewport]', detail: `width=${kv['width']}` });
      if (kv['user-scalable'] === 'no' || kv['user-scalable'] === '0') out.push({ rule: 'viewport', element: 'meta[name=viewport]', detail: 'user-scalable disabled' });
      if (kv['maximum-scale'] && Number(kv['maximum-scale']) < 2) out.push({ rule: 'viewport', element: 'meta[name=viewport]', detail: `maximum-scale=${kv['maximum-scale']}` });

      // --- overflow
      const sw = document.documentElement.scrollWidth;
      if (sw > vw + 1) out.push({ rule: 'overflow', element: 'html', detail: `scrollWidth ${sw} > innerWidth ${vw}` });
      const all = Array.from(document.body.querySelectorAll('*'));
      const reported = new Set<Element>();
      for (const el of all) {
        if (!rendered(el)) continue;
        const v = visibleRect(el);
        if (!v) continue;
        if (v.right > vw + 1 || v.left < -1) {
          // Report the outermost offender only.
          let p = el.parentElement;
          let parentReported = false;
          while (p) {
            if (reported.has(p)) parentReported = true;
            p = p.parentElement;
          }
          reported.add(el);
          if (!parentReported) out.push({ rule: 'overflow', element: describe(el), detail: `spans ${Math.round(v.left)}…${Math.round(v.right)} of ${vw}` });
        }
      }

      // --- tap targets
      const interactive = Array.from(
        document.querySelectorAll(
          'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=radio], [role=tab], [role=slider], [role=checkbox], label.btn, label.switch',
        ),
      );
      const pseudoGrow = (el: Element) => {
        let grow = { l: 0, t: 0, r: 0, b: 0 };
        for (const pseudo of ['::before', '::after']) {
          const cs = getComputedStyle(el, pseudo);
          if (cs.content === 'none' || cs.content === 'normal' || cs.position !== 'absolute') continue;
          const px = (s: string) => (s.endsWith('px') ? parseFloat(s) : 0);
          grow = { l: Math.max(grow.l, -px(cs.left)), t: Math.max(grow.t, -px(cs.top)), r: Math.max(grow.r, -px(cs.right)), b: Math.max(grow.b, -px(cs.bottom)) };
        }
        return grow;
      };
      for (const el of interactive) {
        if (!rendered(el) || !visibleRect(el)) continue;
        if (el.classList.contains('visually-hidden')) continue; // its <label class="btn"> is checked
        if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.closest('label.switch')) continue;
        if (el.tagName === 'A' && el.closest('p, li') && getComputedStyle(el).display === 'inline') continue; // inline text link
        // A checkbox/radio wrapped in its <label>: tapping the label toggles it, so the label is the hit area.
        const wrap = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? el.closest('label') : null;
        const r = (wrap ?? el).getBoundingClientRect();
        const g = pseudoGrow(el);
        const w = r.width + g.l + g.r;
        const h = r.height + g.t + g.b;
        if (w < MIN_TARGET - eps || h < MIN_TARGET - eps) {
          out.push({ rule: 'tap-target', element: describe(el), detail: `${Math.round(w)}×${Math.round(h)} px` });
        }
      }

      // --- input font size
      for (const el of Array.from(document.querySelectorAll('input:not([type=hidden]), select, textarea'))) {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < MIN_INPUT_FONT - 0.01) out.push({ rule: 'input-font', element: describe(el), detail: `${fs}px` });
      }

      // --- small text
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set<Element>();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent || !n.textContent.trim()) continue;
        const el = n.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        if (el.closest('script, style, .visually-hidden') || !rendered(el) || !visibleRect(el)) continue;
        let size = parseFloat(getComputedStyle(el).fontSize);
        if (el instanceof SVGElement) {
          const svg = el.ownerSVGElement;
          const vb = svg?.viewBox.baseVal;
          if (svg && vb && vb.width > 0) size *= svg.getBoundingClientRect().width / vb.width;
        }
        if (size < MIN_TEXT - 0.05) out.push({ rule: 'small-text', element: describe(el), detail: `${size.toFixed(1)}px` });
      }

      // --- safe-area: fixed/sticky bars must use env(safe-area-inset-*)
      const rules: CSSStyleRule[] = [];
      const collect = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSStyleRule) rules.push(rule);
          else if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          collect(sheet.cssRules);
        } catch {
          // cross-origin sheet
        }
      }
      const usesSafeArea = (el: Element) =>
        rules.some((r) => {
          try {
            return el.matches(r.selectorText) && r.cssText.includes('safe-area-inset');
          } catch {
            return false;
          }
        });
      const dialog = document.querySelector('[role=dialog]');
      const bars = all.filter((el) => {
        if (!rendered(el)) return false;
        const pos = getComputedStyle(el).position;
        if (pos !== 'fixed' && pos !== 'sticky') return false;
        const r = el.getBoundingClientRect();
        return !(r.width >= vw - 1 && r.height >= vh - 1); // full-screen overlays are not bars
      });
      if (dialog) bars.push(...Array.from(dialog.querySelectorAll('.sheet-foot')));
      for (const el of bars) {
        if (!usesSafeArea(el)) out.push({ rule: 'safe-area', element: describe(el), detail: 'no env(safe-area-inset-*) in its CSS' });
      }

      // --- primary actions reachable and not covered
      const scrollY = window.scrollY;
      const root: ParentNode = dialog ?? document;
      for (const el of Array.from(root.querySelectorAll('.btn-primary'))) {
        if (!rendered(el)) continue;
        if ((el as HTMLButtonElement).disabled || el.classList.contains('disabled')) continue;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > vw || cy > vh) {
          out.push({ rule: 'covered', element: describe(el), detail: `centre (${Math.round(cx)}, ${Math.round(cy)}) cannot be scrolled into view` });
          continue;
        }
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !(hit === el || el.contains(hit))) {
          out.push({ rule: 'covered', element: describe(el), detail: `covered by ${hit ? describe(hit) : 'nothing'}` });
        }
      }
      window.scrollTo(0, scrollY);
      return out;
    },
    { MIN_TARGET, MIN_TEXT, MIN_INPUT_FONT },
  );
}

export function formatViolations(vs: Violation[]): string {
  return vs.map((v) => `  [${v.rule}] ${v.element}: ${v.detail}`).join('\n');
}
