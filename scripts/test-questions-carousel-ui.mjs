import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { interactiveStudio } from './fixtures/interactive-studio.mjs';

const out = resolve('test-results/questions-carousel');
await mkdir(out, { recursive: true });
const browser = await launchStudioBrowser({ headless: true });
const errors = [];
const questions = ['Quelle présentation ?', 'Quel public ?', 'Quel calendrier ?'].map((question) => ({
  question,
  options: [
    { label: 'Option A', description: 'Une description précise — avec son contexte.' },
    { label: 'Option B', description: 'Une autre possibilité.' },
  ],
}));
let fixture;
try {
  for (const batch of [false, true]) {
    let releaseQuestion;
    const gate = new Promise((resolve) => {
      releaseQuestion = resolve;
    });
    fixture = await interactiveStudio({
      questions: batch ? questions : [questions[0]],
      beforeQuestion: () => gate,
    });
    const contexts = [],
      pages = [];
    for (const width of [1440, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 1000 },
        // The phone is a touch screen: navigation targets grow to 44 px there.
        hasTouch: width === 390,
        locale: 'fr-FR',
        reducedMotion: 'reduce',
      });
      await context.addInitScript((cwd) => {
        if (!localStorage.getItem('prime-studio.selection'))
          localStorage.setItem('prime-studio.selection', JSON.stringify({ cwd, projectOverview: false }));
        localStorage.setItem('prime-studio.language', 'fr');
      }, fixture.cwd);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      contexts.push(context);
      pages.push(page);
    }
    const [desktop, phone] = pages;
    await desktop.goto(fixture.url);
    await expect(desktop.locator('#connection-label')).toContainText('connecté', { timeout: 30000 });
    await desktop.locator('#allow-questions').check();
    await desktop.locator('#composer').fill('Demander mes préférences.');
    await desktop.locator('#send-button').click();
    await expect(desktop.locator('.inline-image-open img').first()).toBeVisible({ timeout: 45000 });
    // Load the same live conversation on the phone, not an unrelated new conversation.
    const selection = await desktop.evaluate(() => localStorage.getItem('prime-studio.selection'));
    await phone.addInitScript(
      (selection) => localStorage.setItem('prime-studio.selection', selection),
      selection,
    );
    await phone.goto(fixture.url);
    await expect(phone.locator('.inline-image-open img').first()).toBeVisible({ timeout: 30000 });
    await desktop.locator('#composer').focus();
    releaseQuestion();
    const active = '.agent-question:not(.question-resolved)';
    await expect(desktop.locator(active)).toBeVisible({ timeout: 45000 });
    await expect(desktop.locator('#composer')).toBeFocused();
    for (const [index, page] of pages.entries()) {
      const form = page.locator(active);
      await expect(form).toBeVisible({ timeout: 30000 });
      const card = form.locator('.question-card:not([hidden])');
      await expect(card.locator('textarea')).toBeVisible();
      await expect(card.locator('details')).toHaveCount(2);
      await card.locator('summary').first().click();
      await expect(card.locator('details').first()).toHaveAttribute('open', '');
      if (!batch) {
        await expect(form.locator('.question-navigation')).toHaveCount(0);
        await expect(form.locator('.question-position')).toHaveCount(0);
        await card.locator('textarea').fill('Réponse libre seule');
      } else {
        const next = form.getByRole('button', { name: 'Question suivante', exact: true });
        const previous = form.getByRole('button', { name: 'Question précédente', exact: true });
        const counter = form.locator('.question-position');
        await expect(counter).toHaveText('Question 1/3');
        await expect(previous).toBeDisabled();
        await card.locator('input[type=radio]').first().check();
        await card.locator('input[type=radio]').first().press('ArrowRight');
        await expect(counter).toHaveText('Question 1/3');
        await card.locator('input[type=radio]').first().check();
        await next.focus();
        await next.press('ArrowRight');
        await expect(counter).toHaveText('Question 2/3');
        await expect(card.locator('h3')).toBeFocused();
        await expect(card.locator('textarea')).toBeVisible();
        await card.locator('textarea').fill('Réponse conservée');
        await card.locator('textarea').press('ArrowLeft');
        await expect(counter).toHaveText('Question 2/3');
        await previous.click();
        await expect(card.locator('input[type=radio]').first()).toBeChecked();
        await expect(card.locator('details').first()).toHaveAttribute('open', '');
        await next.click();
        await expect(card.locator('textarea')).toHaveValue('Réponse conservée');
        // An option clears text; new text clears the option.
        await card.locator('input[type=radio]').last().check();
        await expect(card.locator('textarea')).toHaveValue('');
        await card.locator('textarea').fill('Réponse conservée');
        await expect(card.locator('input[type=radio]:checked')).toHaveCount(0);
        await previous.click();
        await form.getByRole('button', { name: 'Envoyer les réponses', exact: true }).click();
        await expect(counter).toHaveText('Question 3/3');
        await expect(form.locator('.question-error')).toBeVisible();
        await expect(card.locator('h3')).toBeFocused();
        await expect(card.locator('textarea')).toBeVisible();
        await expect(next).toBeDisabled();
        const skip = card.locator('.question-skip');
        await expect(skip).toHaveAttribute('aria-pressed', 'false');
        await expect(skip.locator('.question-skip-icon')).toBeHidden();
        await skip.click();
        // Visible feedback: a pressed toggle with a check, and faded choices.
        await expect(skip).toHaveAttribute('aria-pressed', 'true');
        await expect(skip).toHaveText('Question passée');
        await expect(skip.locator('.question-skip-icon')).toBeVisible();
        await expect(card).toHaveClass(/is-skipped/);
        await expect(form.locator('.question-progress')).toContainText('2 réponse(s) · 1 passée(s)');
        await form.screenshot({ path: join(out, `batch-skipped-${index ? 'phone-390' : 'desktop-1440'}.png`) });
        // Pressing again undoes the skip; skip again for the submission below.
        await skip.click();
        await expect(skip).toHaveAttribute('aria-pressed', 'false');
        await expect(skip).toHaveText('Passer cette question');
        await expect(card).not.toHaveClass(/is-skipped/);
        await expect(form.locator('.question-progress')).toContainText('2 réponse(s) · 0 passée(s)');
        await skip.click();
        await expect(skip).toHaveAttribute('aria-pressed', 'true');
        await previous.click();
        await expect(card.locator('textarea')).toHaveValue('Réponse conservée');
        const bounds = await next.boundingBox();
        const target = index ? 44 : 32;
        assert.ok(bounds.width >= target && bounds.height >= target, `nav target ${bounds.width}x${bounds.height}`);
        // One line across the text width: arrows at both ends, position centered, no separate header.
        const [line, left, middle, field] = await Promise.all([
          form.locator('.question-navigation').boundingBox(),
          previous.boundingBox(),
          counter.boundingBox(),
          card.locator('textarea').boundingBox(),
        ]);
        assert.ok(Math.abs(line.width - field.width) < 2, `line ${line.width} vs text ${field.width}`);
        assert.ok(left.x - line.x < 1 && line.x + line.width - (bounds.x + bounds.width) < 1, 'arrows at the ends');
        assert.ok(Math.abs(middle.y + middle.height / 2 - (left.y + left.height / 2)) < 2, 'same line');
        assert.equal(await form.locator(':scope > h3').count(), 0, 'no separate header');
      }
      await form.scrollIntoViewIfNeeded();
      await expect(page.locator('.cvw-questions-note')).toHaveCount(0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await form.evaluate((element) => element.scrollWidth > element.clientWidth), false);
      await page.screenshot({
        path: join(out, `${batch ? 'batch' : 'single'}-${index ? 'phone-390' : 'desktop-1440'}.png`),
      });
    }
    const phoneForm = phone.locator(active);
    const sent = phone.waitForRequest(
      (request) => request.method() === 'POST' && /\/interactions$/.test(new URL(request.url()).pathname),
    );
    await phoneForm
      .getByRole('button', { name: batch ? 'Envoyer les réponses' : 'Envoyer la réponse', exact: true })
      .click();
    const payload = (await sent).postDataJSON();
    assert.deepEqual(
      payload.response,
      batch
        ? { values: [{ option: 0 }, { text: 'Réponse conservée' }, { skipped: true }] }
        : { value: 'Réponse libre seule' },
    );
    await expect(desktop.locator(active)).toHaveCount(0, { timeout: 30000 });
    await expect(desktop.locator('#stop-button')).toBeHidden({ timeout: 30000 });
    await expect(desktop.locator('#messages')).toContainText(
      batch ? 'Réponse conservée' : 'Réponse libre seule',
    );
    if (batch) {
      await desktop.locator('.activity-stack > summary').click();
      await desktop.locator('.tool-block > summary').click();
      await expect(desktop.locator('.tool-content')).toContainText('Question passée');
      await desktop.screenshot({ path: join(out, 'batch-resolved.png') });
      await desktop.reload();
      await expect(desktop.locator('#messages')).toContainText('Réponse conservée');
      await desktop.locator('.activity-stack > summary').click();
      await desktop.locator('.tool-block > summary').click();
      await expect(desktop.locator('.tool-content')).toContainText('Question passée');
    }
    for (const context of contexts) await context.close();
    await fixture.close();
    fixture = null;
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(out, 'proof.json'),
    JSON.stringify({ passed: true, widths: [1440, 390], errors }, null, 2),
  );
  console.log('Questions carousel UI PASS', out);
} finally {
  await browser.close();
  await fixture?.close();
}
