# web-to-markdown

Extract article-like web pages to clean Markdown using Playwright.

This is a small CLI tool for turning documentation pages and long-form articles into readable Markdown. It prefers `main article` content, keeps common structural elements such as headings, lists, code blocks, and figure captions, and drops common tail sections such as author credits, acknowledgements, and "read more".

## Why

- Save web documentation as local Markdown for note-taking or offline reference
- Create cleaner inputs for coding agents and LLM workflows
- Keep a lightweight, reproducible extraction tool instead of manually copying page text

## Requirements

- Node.js 18 or newer
- Chromium installed through Playwright

## Setup

```bash
npm install
npx playwright install chromium
```

## Usage

Save a page to a specific file:

```bash
npm run extract -- 'https://openai.com/ja-JP/index/harness-engineering/' 'outputs/openai-harness-engineering.md'
```

If you omit the output path, the tool writes to `outputs/<slug>.md`.

```bash
npm run extract -- 'https://developers.openai.com/codex/sdk'
```

## Use Cases

- Convert documentation pages into Markdown you can search, diff, and keep in a project folder
- Build a small local knowledge pack from technical docs before feeding that material into another tool
- Save OpenAI or Codex documentation as Markdown, then provide those files to Codex to help draft repository-specific working rules, prompts, or conventions

That last workflow is a practical one: instead of pasting a large docs page into a prompt every time, you first normalize the page into Markdown, keep it in your repo, and let Codex read those local files when designing rules for how it should operate in that project.

## Notes

- This tool is designed for article-like pages, not arbitrary web apps
- Some sites may block automation or show bot checks
- Respect each site's terms, robots policies, and content licenses before storing or redistributing extracted text

## Project Layout

```text
scripts/
  extract-page.mjs
outputs/
  *.md
```

## License

MIT
