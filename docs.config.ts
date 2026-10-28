import { defineDocsConfig } from '@tenphi/cookbook/config';
import lunaPackage from './package.json' with { type: 'json' };

export default defineDocsConfig({
  site: {
    title: 'Luna',
    version: lunaPackage.version,
    description: 'An assistant that knows your world through your services, conversations, and knowledge.',
    url: 'https://luna.tenphi.me',
    repository: 'https://github.com/tenphi/luna',
    favicon: 'public/luna-icon.png',
    logo: 'public/luna-icon.png',
    headerLinks: [{ label: 'Get started', link: '/getting-started', variant: 'primary' }],
  },
  content: {
    sources: [
      { file: 'docs/index.md', route: '/' },
      { file: 'README.md', route: '/overview' },
      { file: 'docs/README.md', route: '/documentation' },
      { glob: 'docs/**/*.md', base: 'docs', exclude: ['docs/index.md', 'docs/README.md'], navigation: false },
    ],
    localizeRepositoryLinks: false,
  },
  navigation: {
    items: [
      { label: 'Overview', link: '/' },
      {
        label: 'Start here',
        items: [
          { label: 'About Luna', link: '/overview' },
          { label: 'Getting started', link: '/getting-started' },
          { label: 'Everyday use', link: '/everyday-use' },
        ],
      },
      {
        label: 'Integrations',
        items: [
          { label: 'Telegram and shared use', link: '/telegram' },
          { label: 'Apple services', link: '/apple-services' },
          { label: 'Email', link: '/email' },
          { label: 'Akno integration', link: '/akno' },
        ],
      },
      {
        label: 'Reference',
        items: [
          { label: 'Configuration', link: '/configuration' },
          { label: 'CLI reference', link: '/api' },
          { label: 'Operations', link: '/guides' },
          { label: 'Security', link: '/security' },
        ],
      },
      {
        label: 'Development',
        items: [
          { label: 'Architecture', link: '/architecture' },
          { label: 'Agent behavior', link: '/reproducibility' },
          { label: 'Isolation model', link: '/isolation-model' },
          { label: 'Release preparation', link: '/releasing' },
          { label: 'Documentation', link: '/documentation' },
        ],
      },
    ],
  },
  theme: {
    brand: { from: '#7565cf' },
    styles: {
      SiteLogo: { inlineSize: '2rem', blockSize: '2rem' },
      Hero: { Visual: { inlineSize: { '': 'min(100%, 24rem)', '!@md': '16rem' }, blockSize: 'auto' } },
    },
  },
  build: { strict: true, ci: process.env.CI === 'true' },
});
