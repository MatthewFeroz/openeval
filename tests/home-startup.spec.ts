import { expect, test } from '@playwright/test'

test('home navigation and headline do not wait for the run explorer', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/src/landing/RunDatabase.tsx', async route => {
    await held
    await route.continue()
  })
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Compare coding agents.')
    await expect(page.getByRole('link', { name: 'Run a comparison', exact: true })).toBeVisible()
    await expect(page.getByText('Loading OpenEval…', { exact: true })).toHaveCount(0)
  } finally {
    release()
  }
  await expect(page.getByRole('region', { name: 'Every published run. Pick any two.' }).getByRole('table')).toBeVisible()
})

test('a failed explorer download leaves the homepage usable', async ({ page }) => {
  await page.route('**/src/landing/RunDatabase.tsx', route => route.abort('failed'))
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('The comparisons couldn’t load.')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Compare coding agents.')
  await expect(page.getByRole('link', { name: 'Run a comparison', exact: true })).toHaveAttribute('href', '/library?new=1')
  await expect(page.getByRole('link', { name: 'Reload to try again.' })).toHaveAttribute('href', page.url())
})
