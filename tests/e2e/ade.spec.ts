import { expect, test } from '@playwright/test';

test.describe('Web ADE End-to-End Verification', () => {
  test('loads cleanly with Astryx tokens, theme switching, composer, ⌘K, Settings, UI Bridge, Workbench tabs, and @wterm mount', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });
    page.on('response', (res) => {
      if (res.status() >= 500) {
        serverErrors.push(`${res.status()} ${res.url()}`);
      }
    });

    // 1. Load `/` cleanly
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#main-content')).toBeVisible();

    // 2. Verify Astryx styling tokens, Figtree font variable, and initial progressive-disclosure state
    const astryxCheck = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);
      return {
        paletteAttr: root.getAttribute('data-astryx-theme'),
        bgCanvas: styles.getPropertyValue('--bg-canvas').trim(),
        bgSurface: styles.getPropertyValue('--bg-surface').trim(),
        radiusChat: styles.getPropertyValue('--radius-chat').trim(),
        bodyFont: getComputedStyle(document.body).fontFamily,
      };
    });
    expect(['neutral', 'stone', 'matcha', 'obsidian']).toContain(astryxCheck.paletteAttr);
    expect(astryxCheck.bgCanvas.length).toBeGreaterThan(0);
    expect(astryxCheck.bgSurface.length).toBeGreaterThan(0);
    expect(['28px', '1.75rem']).toContain(astryxCheck.radiusChat);

    // Workbench starts closed on an empty chat (progressive disclosure)
    await expect(page.locator('section[aria-label="Workspace Workbench"]')).toHaveCount(0);

    // 3. Verify Composer & Starter Prompt Cards
    const composer = page.getByRole('textbox', { name: 'Message Web ADE' });
    await expect(composer).toBeVisible();
    await expect(page.getByText('Build an interactive web app')).toBeVisible();

    // Verify `/` TriggerMenu opens in Composer
    await composer.click();
    await composer.fill('/');
    await expect(page.getByText('Slash Commands')).toBeVisible();
    await composer.fill('');

    // 4. Verify Light / Dark toggle and Astryx palette switching
    const themeTrigger = page.getByRole('button', { name: 'Theme and Astryx palette' });
    await themeTrigger.click();
    await page.getByRole('menuitem', { name: 'Dark' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe('dark');

    await themeTrigger.click();
    await page.getByRole('menuitem', { name: 'Light' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.colorScheme))
      .toBe('light');

    await themeTrigger.click();
    await page.getByRole('menuitem', { name: /Matcha/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-astryx-theme', 'matcha');

    // Reset back to Neutral Cobalt
    await themeTrigger.click();
    await page.getByRole('menuitem', { name: /Neutral/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-astryx-theme', 'neutral');

    // 5. Verify ⌘K Command Palette (@ui-sdk/react/command)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const paletteDialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(paletteDialog).toBeVisible();
    await expect(paletteDialog.getByText('@ui-sdk/react/command')).toBeVisible();

    const paletteInput = paletteDialog.getByRole('combobox');
    await paletteInput.fill('Settings');
    await expect(paletteDialog.getByText('Settings, Providers & Billing Waterfall')).toBeVisible();

    // Open Settings & Providers directly from Command Palette
    await paletteDialog.getByText('Settings, Providers & Billing Waterfall').click();

    // 6. Verify Settings & Providers Dialog (5-Tier Waterfall 1/2a/2b/3/4/5 + Custom OpenAI-Compatible inputs)
    const settingsHeading = page.getByRole('heading', { name: /Workspace Settings & Providers/i });
    await expect(settingsHeading).toBeVisible();
    await expect(page.getByText('5-Tier Provider & Billing Waterfall')).toBeVisible();
    await expect(page.getByText('2a', { exact: true })).toBeVisible();
    await expect(page.getByText('2b', { exact: true })).toBeVisible();
    await expect(page.getByText('Custom OpenAI-Compatible Endpoint').first()).toBeVisible();
    await expect(page.getByText('Your BYOK API Key (OpenAI / Gateway)')).toBeVisible();
    await expect(page.getByText('Signed-in Vercel Account Credits')).toBeVisible();
    await expect(page.getByText('Host Sponsor OpenAI (Primary)')).toBeVisible();
    await expect(page.getByText('Host Sponsor AI Gateway')).toBeVisible();
    await expect(page.getByText('Vercel Project OIDC (Zero-Config)')).toBeVisible();

    // Verify Tier 1 Custom OpenAI-Compatible inputs are interactive
    const baseUrlInput = page.locator('#ade-custom-base-url');
    const apiKeyInput = page.locator('#ade-custom-api-key');
    const modelInput = page.locator('#ade-custom-model');
    await expect(baseUrlInput).toBeVisible();
    await expect(apiKeyInput).toBeVisible();
    await expect(modelInput).toBeVisible();
    await baseUrlInput.fill('http://localhost:11434/v1');
    await expect(baseUrlInput).toHaveValue('http://localhost:11434/v1');
    await baseUrlInput.fill('');

    // Verify Harnesses & Sandbox tab + Appearance tab
    await page.getByRole('tab', { name: /Harnesses & Sandbox/i }).click();
    await expect(page.getByText('Remote MCP Server Endpoint')).toBeVisible();
    await expect(page.getByText('/api/mcp')).toBeVisible();

    await page.getByRole('tab', { name: /Appearance/i }).click();
    await expect(page.getByText('Astryx Palette')).toBeVisible();

    // Close Settings dialog
    await page.keyboard.press('Escape');
    await expect(settingsHeading).toHaveCount(0);

    // 7. Verify UI Bridge Popover (@ui-sdk/react/agent) + Live Self-Operating Demo
    const uiBridgeBtn = page.locator('[data-slot="ui-bridge-trigger"]');
    await expect(uiBridgeBtn).toBeVisible();
    await uiBridgeBtn.click();
    await expect(page.getByText('Self-Operating UI Bridge')).toBeVisible();
    await expect(page.getByText('ui-sdk/agent', { exact: true })).toBeVisible();
    await expect(page.getByText('ade.theme')).toBeVisible();

    // Run Demo Self-Operating UI (switches palette & opens Workbench on Trace tab!)
    await page.getByRole('button', { name: 'Demo Self-Operating UI' }).click();
    const workbench = page.locator('section[aria-label="Workspace Workbench"]');
    await expect(workbench).toBeVisible();

    // Close UI Bridge popover by pressing Escape
    await page.keyboard.press('Escape');

    // 8. Verify ALL Workbench Tabs (Preview, Browser, Terminal + @wterm, Files, GenUI, Trace)
    const tablist = workbench.getByRole('tablist', { name: 'Workbench panes' });

    // Trace tab (already active from UI Bridge Demo)
    await tablist.getByRole('tab', { name: /Trace/i }).click();
    await expect(tablist.getByRole('tab', { name: /Trace/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Preview tab
    await tablist.getByRole('tab', { name: /Preview/i }).click();
    await expect(tablist.getByRole('tab', { name: /Preview/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Browser tab
    await tablist.getByRole('tab', { name: /Browser/i }).click();
    await expect(tablist.getByRole('tab', { name: /Browser/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Files tab — verify starter files tree and file selection
    await tablist.getByRole('tab', { name: /Files/i }).click();
    await expect(tablist.getByRole('tab', { name: /Files/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(workbench.getByText('README.md').first()).toBeVisible();
    await workbench.getByText('index.html').first().click();
    await expect(workbench.getByText('Web ADE').first()).toBeVisible();

    // GenUI Canvas tab
    await tablist.getByRole('tab', { name: /GenUI/i }).click();
    await expect(tablist.getByRole('tab', { name: /GenUI/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(workbench.getByText('GenUI Canvas (json-render)')).toBeVisible();

    // Terminal tab + @wterm/react mount verification
    await tablist.getByRole('tab', { name: /Term/i }).click();
    await expect(tablist.getByRole('tab', { name: /Term/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(workbench.getByRole('tab', { name: 'Instant Bash' })).toBeVisible();
    await expect(workbench.getByRole('tab', { name: 'Cloud Sandbox' })).toBeVisible();
    await expect(workbench.getByText('WebMCP:shell')).toBeVisible();

    // Wait for @wterm WASM/DOM terminal to finish mounting inside the obsidian surface
    const terminalSurface = workbench.locator('.astryx-dark-surface');
    await expect(terminalSurface).toBeVisible();
    await expect
      .poll(async () => {
        return terminalSurface.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const hasWtermDom = Boolean(
            el.querySelector('[class*="wterm"], canvas, textarea, [role="textbox"], .wterm-screen'),
          );
          return rect.width > 100 && rect.height > 100 && hasWtermDom;
        });
      })
      .toBe(true);

    // 9. Toggle Workbench closed cleanly
    await workbench.getByRole('button', { name: 'Close Workbench' }).click();
    await expect(workbench).toHaveCount(0);

    // Re-open via TopBar Workbench button
    await page.getByRole('button', { name: 'Open Workbench' }).click();
    await expect(workbench).toBeVisible();

    // 10. Strict zero-error assertions
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(serverErrors).toEqual([]);
  });

  test('returns genuine HTTP 404 for nonexistent or unauthorized /chat/[id] routes', async ({
    page,
  }) => {
    const response = await page.goto('/chat/nonexistent-private-chat-id', {
      waitUntil: 'domcontentloaded',
    });
    expect(response?.status()).toBe(404);
  });
});
