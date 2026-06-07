import i18n from '../src/i18n'
it('defaults to zh and switches to en', async () => {
  expect(i18n.language).toBe('zh')
  expect(i18n.t('common.newConnection')).toBe('新建连接')
  await i18n.changeLanguage('en')
  expect(i18n.t('common.newConnection')).toBe('New connection')
})
