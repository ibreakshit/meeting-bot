import type { Locator, Page } from 'playwright';
import { createCursor, type GhostCursor } from '../vendor/human-cursor/spoof';

const cursors = new WeakMap<Page, GhostCursor>();

async function cursorFor(page: Page): Promise<GhostCursor> {
  const existing = cursors.get(page);
  if (existing) return existing;
  // A pointer that first appears at (0,0) is a bot tell, so start somewhere inside the window.
  const start = await page.evaluate(() => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight }));
  const cursor = cursors.get(page) ?? createCursor(page, start);
  cursors.set(page, cursor);
  return cursor;
}

/** Move along a human-like path to a random point inside the target, then click there with trusted mouse events. */
export async function humanClick(target: Locator, { timeout = 5000, force = false } = {}): Promise<void> {
  const cursor = await cursorFor(target.page());
  await target.waitFor({ state: 'visible', timeout });
  // A wrapped inline link's bounding box includes empty corners another element would receive,
  // so aim inside its largest line box (offsets relative to the bounding box work inside iframes too).
  const line = await target.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return Array.from(element.getClientRects(), rect => ({ x: rect.x - bounds.x, y: rect.y - bounds.y, width: rect.width, height: rect.height }))
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  });
  const destination = line && line.width > 0 && line.height > 0
    ? { x: line.x + line.width * (0.2 + Math.random() * 0.6), y: line.y + line.height * (0.2 + Math.random() * 0.6) }
    : undefined;
  await cursor.move(target, { destination });
  const box = await target.boundingBox();
  if (!box) throw new Error('Click target disappeared before the click');
  const { x, y } = cursor.getLocation();
  // Not cursor.click(): it swallows click errors and re-aims at the element centre.
  // Playwright still checks that this point hits an enabled target unless force is set.
  await target.click({ position: { x: x - box.x, y: y - box.y }, delay: 40 + Math.random() * 60, timeout, force });
}

/** Click a text field like a person, replace its contents, and type with uneven key timing. */
export async function humanType(target: Locator, text: string): Promise<void> {
  await humanClick(target);
  const { keyboard } = target.page();
  await keyboard.press('Control+A');
  for (const character of text) {
    await keyboard.type(character);
    await target.page().waitForTimeout(50 + Math.random() * 120);
  }
  // Focus can be stolen mid-typing by a late prompt; a wrong display name is worse than a fill.
  if (await target.inputValue() !== text) await target.fill(text);
}

/** Glide the pointer to a page point, e.g. a corner to clear hover tooltips without teleporting. */
export async function humanMoveTo(page: Page, point: { x: number; y: number }): Promise<void> {
  await (await cursorFor(page)).moveTo(point);
}
