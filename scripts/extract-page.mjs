import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const DEFAULT_URL = "https://openai.com/ja-JP/index/harness-engineering/";
const STOP_HEADINGS = new Set([
  "著者",
  "謝辞",
  "さらに読む",
  "Author",
  "Acknowledgements",
  "Read more",
]);

function slugifyFromUrl(inputUrl) {
  const url = new URL(inputUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const lastPart = parts.at(-1) || url.hostname;
  return lastPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "page";
}

function buildOutputPath(inputUrl, explicitPath) {
  if (explicitPath) {
    return path.resolve(process.cwd(), explicitPath);
  }

  return path.resolve(process.cwd(), "outputs", `${slugifyFromUrl(inputUrl)}.md`);
}

function metadataLine(label, value) {
  return value ? `- ${label}: ${value}` : "";
}

async function extractPage(url) {
  const attemptExtraction = async (headless) => {
    const browser = await chromium.launch({ headless });

    try {
    const context = await browser.newContext({
      locale: "ja-JP",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 1800 },
    });
    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    const pageTitle = await page.title();
    const bodyText = await page.locator("body").innerText().catch(() => "");

    if (
      /just a moment/i.test(pageTitle) ||
      /Enable JavaScript and cookies to continue/i.test(bodyText)
    ) {
      throw new Error(`Cloudflare challenge detected in ${headless ? "headless" : "headed"} mode.`);
    }

    const rejectCookiesButtons = [
      page.getByRole("button", { name: /必須でないCookieを拒否/i }),
      page.getByRole("button", { name: /Reject non-essential cookies/i }),
      page.getByRole("button", { name: /Decline/i }),
    ];

    for (const button of rejectCookiesButtons) {
      try {
        await button.click({ timeout: 2_000 });
        break;
      } catch {
        // Ignore missing cookie banners.
      }
    }

    await page.locator("main article, article, main, body").first().waitFor({
      state: "attached",
      timeout: 20_000,
    });

    const extracted = await page.evaluate((stopHeadings) => {
      const stopHeadingSet = new Set(stopHeadings);

      const normalizeWhitespace = (value) =>
        value
          .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
          .replace(/\u00a0/g, " ")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n[ \t]+/g, "\n")
          .replace(/[ \t]{2,}/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

      const normalizeInline = (value) =>
        value
          .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .replace(/\s+([,.;:!?])/g, "$1")
          .trim();

      const normalizeCode = (value) =>
        value
          .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
          .replace(/\u00a0/g, " ")
          .replace(/\r/g, "")
          .replace(/\t/g, "    ")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/[ \t]+$/gm, "")
          .trim();

      const isAuxiliaryText = (value) =>
        /^(?:\(?（?新しいウィンドウで開く）?\)?|opens in a new window)$/i.test(
          normalizeInline(value),
        );

      const escapeMarkdown = (value) => value.replace(/([*_`])/g, "\\$1");

      const absoluteUrl = (href) => {
        try {
          return new URL(href, window.location.href).toString();
        } catch {
          return href;
        }
      };

      const extractStructuredPre = (pre) => {
        const rowElements = Array.from(pre.children).filter(
          (child) =>
            child instanceof HTMLElement &&
            child.tagName === "DIV" &&
            /flex-row/.test(child.className),
        );

        const rows = rowElements
          .filter((child) => child instanceof HTMLElement)
          .map((row) => {
            const columns = Array.from(row.children).filter((child) => child instanceof HTMLElement);

            if (columns.length !== 2) {
              return null;
            }

            const lineNumber = normalizeInline(columns[0].innerText || columns[0].textContent || "");
            const lineText = normalizeCode(columns[1].innerText || columns[1].textContent || "");

            if (!/^\d+$/.test(lineNumber) || !lineText) {
              return null;
            }

            return { lineNumber, lineText };
          })
          .filter(Boolean);

        if (!rows.length) {
          return "";
        }

        const lineNumberWidth = Math.max(
          ...rows.map((row) => row.lineNumber.length),
          1,
        );

        return rows
          .map((row) =>
            row.lineNumber
              ? `${row.lineNumber.padStart(lineNumberWidth, " ")} ${row.lineText}`.trimEnd()
              : row.lineText,
          )
          .join("\n");
      };

      const extractFileTree = (container) => {
        const rootList = container.querySelector('[role="tree"], ul');
        if (!(rootList instanceof HTMLElement)) {
          return "";
        }

        const getDirectChild = (parent, selector) =>
          Array.from(parent.children).find(
            (child) => child instanceof Element && child.matches(selector),
          ) || null;

        const getRow = (item) => {
          const directRow = getDirectChild(item, ".file-tree-row");
          if (directRow) {
            return directRow;
          }

          const details = getDirectChild(item, "details");
          if (details) {
            return getDirectChild(details, "summary.file-tree-row");
          }

          return null;
        };

        const getChildrenList = (item) => {
          const details = getDirectChild(item, "details");
          if (!details) {
            return null;
          }

          const childrenWrap = getDirectChild(details, ".file-tree-children");
          if (!childrenWrap) {
            return null;
          }

          return getDirectChild(childrenWrap, "ul");
        };

        const getName = (row) => {
          const nameEl =
            row.querySelector(".file-tree-name .font-medium") ||
            row.querySelector(".file-tree-name .inline-flex") ||
            row.querySelector(".file-tree-name");
          return normalizeInline(nameEl?.textContent || "");
        };

        const getDescription = (row) => {
          const descriptionEl = Array.from(row.children).find(
            (child) =>
              child instanceof HTMLElement &&
              child !== row.querySelector(".file-tree-name") &&
              /text-secondary/.test(child.className),
          );
          return normalizeInline(descriptionEl?.textContent || "");
        };

        const lines = [];

        const visit = (list, ancestorLastFlags = []) => {
          const items = Array.from(list.children).filter(
            (child) => child instanceof HTMLElement && child.matches("li"),
          );

          items.forEach((item, index) => {
            const row = getRow(item);
            if (!row) {
              return;
            }

            const name = getName(row);
            const description = getDescription(row);
            const isLast = item.hasAttribute("data-last") || index === items.length - 1;
            const depth = ancestorLastFlags.length;
            const indent = ancestorLastFlags
              .slice(1)
              .map((flag) => (flag ? "    " : "│   "))
              .join("");
            const branch = depth === 0 ? "" : isLast ? "└── " : "├── ";
            const line = `${indent}${branch}${name}${description ? `  ${description}` : ""}`.trimEnd();

            if (line) {
              lines.push(line);
            }

            const childrenList = getChildrenList(item);
            if (childrenList) {
              visit(childrenList, [...ancestorLastFlags, isLast]);
            }
          });
        };

        visit(rootList);
        return lines.join("\n");
      };

      const renderInline = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent || "";
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
          return "";
        }

        const element = node;

        if (element.matches("script, style, button, svg, path, audio")) {
          return "";
        }

        if (
          element.getAttribute("aria-hidden") === "true" ||
          element.classList.contains("sr-only") ||
          element.classList.contains("screen-reader-only") ||
          element.classList.contains("visually-hidden")
        ) {
          return "";
        }

        if (element.tagName === "BR") {
          return "\n";
        }

        if (element.tagName === "IMG") {
          return element.getAttribute("alt") || "";
        }

        const content = Array.from(element.childNodes).map(renderInline).join("");
        const cleanContent = normalizeInline(content);

        if (!cleanContent) {
          return "";
        }

        if (isAuxiliaryText(cleanContent)) {
          return "";
        }

        if (element.tagName === "A") {
          const href = element.getAttribute("href");
          const url = href ? absoluteUrl(href) : "";
          return url ? `[${escapeMarkdown(cleanContent)}](${url})` : cleanContent;
        }

        if (element.tagName === "CODE") {
          return `\`${cleanContent}\``;
        }

        if (element.tagName === "STRONG" || element.tagName === "B") {
          return `**${escapeMarkdown(cleanContent)}**`;
        }

        if (element.tagName === "EM" || element.tagName === "I") {
          return `*${escapeMarkdown(cleanContent)}*`;
        }

        return content;
      };

      const toText = (element) => normalizeWhitespace(renderInline(element));

      const articleLikeRoot =
        document.querySelector("main article") ||
        document.querySelector("article") ||
        document.querySelector("main");
      const article = articleLikeRoot || document.body;
      const usesDocumentBodyFallback = !articleLikeRoot;
      const main = article.closest("main") || document.querySelector("main");
      const articleHeader = article.previousElementSibling;
      const heading =
        article.querySelector("h1") ||
        articleHeader?.querySelector?.("h1") ||
        main?.querySelector?.("h1") ||
        document.querySelector("h1");
      const title = normalizeInline(heading?.textContent || document.title);
      const headingContainer = heading?.parentElement || null;
      const metadataRoots = Array.from(
        new Set([headingContainer, articleHeader, article].filter(Boolean)),
      );

      const datePatterns = [
        /\d{4}年\d{1,2}月\d{1,2}日/,
        /\d{4}\/\d{1,2}\/\d{1,2}/,
        /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i,
      ];

      const looksLikeDate = (text) => datePatterns.some((pattern) => pattern.test(text));
      const extractFirstDate = (text) =>
        datePatterns
          .map((pattern) => text.match(pattern)?.[0] || "")
          .find(Boolean) || "";

      const normalizeAuthor = (text) => normalizeInline(text).replace(/^By\s+/i, "");

      const looksLikeAuthor = (text) =>
        text.length <= 120 &&
        !looksLikeDate(text) &&
        !/^(?:View on GitHub|Download raw|Copy Page|More page actions)$/i.test(text) &&
        (/^By\s+[A-Z][\p{L}\p{M}'’. -]+$/u.test(text) ||
          /(Technical Staff|メンバー|Member|作者)/i.test(text));

      const looksLikePersonName = (text) =>
        text.length <= 120 &&
        !looksLikeDate(text) &&
        !/^(?:View on GitHub|Download raw|Copy Page|More page actions)$/i.test(text) &&
        /^[\p{L}\p{M}][\p{L}\p{M}'’. -]+$/u.test(text);

      const metadataCandidates = metadataRoots.flatMap((root) =>
        Array.from(
          root.querySelectorAll(root === article ? "p, time, a" : "p, time, a, span"),
        )
          .map((node) => normalizeInline(node.textContent || ""))
          .filter(Boolean),
      );

      const authorFromProfileLink = metadataRoots
        .flatMap((root) =>
          Array.from(
            root.querySelectorAll('a[aria-label*="View profile of"], a[rel="author"], [itemprop="author"] a'),
          ),
        )
        .map((node) => {
          const ariaLabel = normalizeInline(node.getAttribute("aria-label") || "");
          const labelMatch = ariaLabel.match(/^View profile of (.+)$/i);
          return normalizeAuthor(labelMatch?.[1] || node.textContent || "");
        })
        .find((text) => looksLikeAuthor(text) || looksLikePersonName(text));
      const authorFromAdjacentHeading = usesDocumentBodyFallback
        ? Array.from(document.body.children)
            .slice(0, 12)
            .filter((node) => {
              if (!(node instanceof HTMLElement) || node === heading) {
                return false;
              }

              if (!node.matches("h2, h3, h4")) {
                return false;
              }

              if (node.querySelectorAll("a").length > 0) {
                return false;
              }

              const text = normalizeInline(node.textContent || "");

              if (!text || text === title || text === "目次") {
                return false;
              }

              if (/^[0-9０-９]/.test(text) || /^第[0-9０-９一二三四五六七八九十]/.test(text)) {
                return false;
              }

              return looksLikePersonName(text);
            })
            .map((node) => ({
              text: normalizeAuthor(node.textContent || ""),
              score:
                (node.tagName === "H2" ? 4 : 0) +
                (node.classList.contains("title") ? 2 : 0) +
                (normalizeInline(node.textContent || "").length <= 24 ? 1 : 0),
            }))
            .sort((left, right) => right.score - left.score)[0]?.text || ""
        : "";
      const author =
        authorFromProfileLink ||
        normalizeAuthor(authorFromAdjacentHeading) ||
        metadataCandidates.map(normalizeAuthor).find((text) => looksLikeAuthor(text)) ||
        "";
      const publishedAt =
        metadataCandidates.map((text) => extractFirstDate(text)).find(Boolean) || "";
      const category =
        article
          .querySelector('a[href*="/news/"], a[href*="/engineering/"], a[href*="/research/"]')
          ?.textContent?.trim() || "";

      const blockSelector = "p, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, figure";
      const directContentBlocks = Array.from(article.children).filter(
        (child) =>
          child.matches(blockSelector) ||
          (child.tagName === "DIV" && child.querySelector(blockSelector)),
      );
      const contentRoot =
        directContentBlocks.length >= 4
          ? article
          : Array.from(article.children)
              .filter((child) => !child.querySelector("h1"))
              .map((child) => ({
                child,
                score:
                  (child.matches(blockSelector) ? 1 : 0) + child.querySelectorAll(blockSelector).length,
              }))
              .sort((left, right) => right.score - left.score)[0]?.child || article;
      const isLikelyTableOfContents = (node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }

        const text = normalizeInline(node.textContent || "");
        const links = Array.from(node.querySelectorAll("a"));
        const samePageLinks = links.filter((link) => link.getAttribute("href")?.startsWith("#"));

        return (
          /^目次$/i.test(text) ||
          text.startsWith("目次 ") ||
          (samePageLinks.length >= 6 && samePageLinks.length >= Math.max(links.length - 1, 1))
        );
      };

      const extractDescriptionList = (list) => {
        const parts = [];
        let currentTerm = "";

        for (const child of list.children) {
          if (!(child instanceof HTMLElement)) {
            continue;
          }

          if (child.tagName === "DT") {
            currentTerm = toText(child);
            continue;
          }

          if (child.tagName === "DD") {
            const definition = toText(child);

            if (currentTerm && definition) {
              parts.push(`- ${currentTerm}: ${definition}`);
            } else if (definition) {
              parts.push(`- ${definition}`);
            }
          }
        }

        return parts.join("\n");
      };

      const rawBlocks = [];
      let shouldStop = false;

      const pushBlock = (value, options = {}) => {
        const block = options.preserveWhitespace
          ? normalizeCode(value)
          : normalizeWhitespace(value);

        if (!block) {
          return;
        }

        if (rawBlocks.at(-1) !== block) {
          rawBlocks.push(block);
        }
      };

      const walk = (node) => {
        if (shouldStop || !(node instanceof Element)) {
          return;
        }

        if (
          node.matches(
            "script, style, nav, footer, form, button, dialog, aside, [aria-hidden='true']",
          )
        ) {
          return;
        }

        if (isLikelyTableOfContents(node)) {
          return;
        }

        if (heading && (node === heading || node.contains(heading))) {
          return;
        }

        if (node.matches("h2, h3, h4, h5, h6")) {
          const headingText = normalizeInline(node.textContent || "");

          if (stopHeadingSet.has(headingText)) {
            shouldStop = true;
            return;
          }

          const level = Number(node.tagName.slice(1));
          pushBlock(`${"#".repeat(level)} ${toText(node)}`);
          return;
        }

        if (node.matches("p")) {
          pushBlock(toText(node));
          return;
        }

        if (node.matches("ul, ol")) {
          const items = Array.from(node.children)
            .filter((child) => child.tagName === "LI")
            .map((child, index) => {
              const marker = node.tagName === "OL" ? `${index + 1}.` : "-";
              return `${marker} ${toText(child)}`;
            });

          pushBlock(items.join("\n"));
          return;
        }

        if (node.matches("blockquote")) {
          const quoteText = toText(node);
          if (!quoteText) {
            return;
          }

          const lines = quoteText
            .split("\n")
            .map((line) => `> ${line}`);
          pushBlock(lines.join("\n"));
          return;
        }

        if (node.matches("details")) {
          const summary = node.querySelector(":scope > summary");
          const summaryText = summary ? toText(summary) : "";

          if (summaryText) {
            pushBlock(`### ${summaryText}`);
          }

          for (const child of node.children) {
            if (child !== summary) {
              walk(child);
              if (shouldStop) {
                return;
              }
            }
          }
          return;
        }

        if (node.matches("pre")) {
          const structuredText = extractStructuredPre(node);
          const text = structuredText || normalizeCode(node.innerText || node.textContent || "");
          if (text) {
            pushBlock(`\`\`\`\n${text}\n\`\`\``, { preserveWhitespace: true });
          }
          return;
        }

        if (node.matches("figure")) {
          const figcaption = node.querySelector("figcaption");
          const img = node.querySelector("img");
          const description = normalizeWhitespace(
            figcaption?.innerText || img?.getAttribute("alt") || "",
          );

          if (description) {
            pushBlock(`> Figure: ${description}`);
          }
          return;
        }

        if (node.matches(".figure, div.figure")) {
          const img = node.querySelector("img");
          const description = normalizeWhitespace(img?.getAttribute("alt") || "");

          if (description) {
            pushBlock(`> Figure: ${description}`);
          }
          return;
        }

        if (node.matches("dl")) {
          const text = extractDescriptionList(node);
          if (text) {
            pushBlock(text);
          }
          return;
        }

        if (node.matches("[data-file-tree], .file-tree-container")) {
          const text = extractFileTree(node);
          if (text) {
            pushBlock(`\`\`\`\n${text}\n\`\`\``, { preserveWhitespace: true });
          }
          return;
        }

        for (const child of node.children) {
          walk(child);
          if (shouldStop) {
            return;
          }
        }
      };

      const contentChildren = Array.from(contentRoot.children).filter((child) => {
        if (!(child instanceof HTMLElement)) {
          return false;
        }

        if (!usesDocumentBodyFallback) {
          return true;
        }

        if (
          child.classList.contains("title") &&
          (child.querySelectorAll("a").length >= 2 ||
            (author && normalizeInline(child.textContent || "") === author))
        ) {
          return false;
        }

        return true;
      });

      for (const child of contentChildren) {
        walk(child);
        if (shouldStop) {
          break;
        }
      }

      const metadataToSkip = new Set([publishedAt, author, category].filter(Boolean));
      const blocks = rawBlocks.filter(
        (block, index) =>
          !(
            index < 6 &&
            (metadataToSkip.has(block) ||
              (author &&
                (block === `## ${author}` ||
                  block === `### ${author}` ||
                  block === `#### ${author}`)))
          ),
      );

      return {
        title,
        publishedAt,
        author,
        category,
        blocks,
      };
    }, Array.from(STOP_HEADINGS));

    return {
      ...extracted,
      finalUrl: page.url(),
      retrievedAt: new Date().toISOString(),
    };
    } finally {
      await browser.close();
    }
  };

  try {
    return await attemptExtraction(true);
  } catch (headlessError) {
    return await attemptExtraction(false).catch((headedError) => {
      headedError.cause = headlessError;
      throw headedError;
    });
  }
}

async function main() {
  const [urlArg, outputArg] = process.argv.slice(2);
  const url = urlArg || DEFAULT_URL;
  const outputPath = buildOutputPath(url, outputArg);

  const extracted = await extractPage(url);

  const frontmatter = [
    "---",
    `title: ${JSON.stringify(extracted.title)}`,
    `source: ${JSON.stringify(extracted.finalUrl)}`,
    `retrieved_at: ${JSON.stringify(extracted.retrievedAt)}`,
    extracted.publishedAt ? `published_at: ${JSON.stringify(extracted.publishedAt)}` : "",
    extracted.author ? `author: ${JSON.stringify(extracted.author)}` : "",
    extracted.category ? `category: ${JSON.stringify(extracted.category)}` : "",
    "---",
  ]
    .filter(Boolean)
    .join("\n");

  const metadata = [
    metadataLine("Source", extracted.finalUrl),
    metadataLine("Retrieved At", extracted.retrievedAt),
    metadataLine("Published At", extracted.publishedAt),
    metadataLine("Author", extracted.author),
    metadataLine("Category", extracted.category),
  ]
    .filter(Boolean)
    .join("\n");

  const markdown = [
    frontmatter,
    "",
    `# ${extracted.title}`,
    "",
    metadata,
    "",
    "## Extracted Text",
    "",
    extracted.blocks.join("\n\n"),
    "",
  ].join("\n");

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, "utf8");

  console.log(`Saved extracted markdown to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
