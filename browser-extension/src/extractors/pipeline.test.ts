import { test } from "node:test";
import assert from "node:assert/strict";

import { parseHTML } from "linkedom";

import { buildBibtex } from "../bibtex.ts";
import { extractFromTab, extractPage } from "./index.ts";
import { collectPreviews, fillBlanks, identifyPage, lookupFields, parseArxivAtom, parseCrossref, parseEsummary } from "./lookup.ts";
import { displayName, normalizeDate } from "./normalize.ts";
import { doiFromUrl, findDois, parseIsbn } from "./identifiers.ts";

const page = (head: string, body = "") =>
  parseHTML(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`).document as unknown as Document;

const URL_ = "https://example.org/some/page";

test("highwire tags on any host", () => {
  const { preview, candidates } = extractPage(
    page(`
      <title>Site title</title>
      <meta name="citation_title" content="A paper">
      <meta name="citation_author" content="Ada Lovelace">
      <meta name="citation_author" content="Alan Turing">
      <meta name="citation_journal_title" content="Journal of Things">
      <meta name="citation_volume" content="12">
      <meta name="citation_issue" content="3">
      <meta name="citation_firstpage" content="100">
      <meta name="citation_lastpage" content="110">
      <meta name="citation_publication_date" content="2021/03/15">
      <meta name="citation_doi" content="10.1234/abc.def">
      <meta name="citation_pdf_url" content="https://example.org/a.pdf">`),
    URL_
  );

  assert.equal(preview.title, "A paper");
  assert.deepEqual(preview.authors, ["Ada Lovelace", "Alan Turing"]);
  assert.equal(preview.journal, "Journal of Things");
  assert.equal(preview.pages, "100-110");
  assert.equal(preview.date, "2021-03-15");
  assert.equal(preview.doi, "10.1234/abc.def");
  assert.equal(preview.pdfUrl, "https://example.org/a.pdf");
  assert.deepEqual(preview.target, { kind: "doi", value: "10.1234/abc.def" });
  assert.equal(preview.sources.title, "highwire");
  assert.deepEqual(candidates, []);
});

test("bepress uses the same reader", () => {
  const { preview } = extractPage(
    page(`<meta name="bepress_citation_title" content="Repository work">
          <meta name="bepress_citation_author" content="Grace Hopper">
          <meta name="bepress_citation_date" content="1999">`),
    URL_
  );

  assert.equal(preview.title, "Repository work");
  assert.equal(preview.year, "1999");
  assert.equal(preview.date, undefined);
});

test("eprints", () => {
  const { preview } = extractPage(
    page(`<meta name="eprints.title" content="An eprint">
          <meta name="eprints.creators_name" content="Noether, Emmy">
          <meta name="eprints.date" content="2010-05">
          <meta name="eprints.type" content="thesis">`),
    URL_
  );

  assert.equal(preview.type, "thesis");
  assert.deepEqual(preview.authors, ["Noether, Emmy"]);
  assert.equal(preview.year, "2010");
});

test("Dublin Core in any case, with a DOI among identifiers", () => {
  const { preview } = extractPage(
    page(`<meta name="DC.Title" content="Dublin paper">
          <meta name="DC.Creator" content="Rosalind Franklin">
          <meta name="DC.Identifier" content="doi:10.5555/dublin.1">
          <meta name="DCTERMS.issued" content="1953-04-25">`),
    URL_
  );

  assert.equal(preview.title, "Dublin paper");
  assert.equal(preview.doi, "10.5555/dublin.1");
  assert.equal(preview.date, "1953-04-25");
  assert.equal(preview.sources.title, "dublin-core");
});

test("PRISM adds journal details to another layer's title", () => {
  const { preview } = extractPage(
    page(`<meta name="dc.title" content="Prism paper">
          <meta name="prism.publicationName" content="Prism Journal">
          <meta name="prism.volume" content="7">
          <meta name="prism.startingPage" content="1">
          <meta name="prism.endingPage" content="9">
          <meta name="prism.doi" content="10.5555/prism.2">`),
    URL_
  );

  assert.equal(preview.journal, "Prism Journal");
  assert.equal(preview.pages, "1-9");
  assert.equal(preview.doi, "10.5555/prism.2");
});

test("JSON-LD scholarly article inside @graph", () => {
  const json = JSON.stringify({
    "@graph": [
      { "@type": "WebSite", name: "A site" },
      {
        "@type": "ScholarlyArticle",
        headline: "Graph paper",
        author: [{ "@type": "Person", givenName: "Marie", familyName: "Curie" }, { name: "Pierre Curie" }],
        datePublished: "1903-06-25T00:00:00Z",
        identifier: { value: "https://doi.org/10.5555/graph.3" },
        isPartOf: { "@type": "PublicationIssue", issueNumber: "2", isPartOf: { "@type": "Periodical", name: "Graph Journal" } },
        publisher: { name: "A Publisher" },
      },
    ],
  });
  const { preview } = extractPage(page(`<script type="application/ld+json">${json}</script>`), URL_);

  assert.equal(preview.title, "Graph paper");
  assert.deepEqual(preview.authors, ["Marie Curie", "Pierre Curie"]);
  assert.equal(preview.date, "1903-06-25");
  assert.equal(preview.doi, "10.5555/graph.3");
  assert.equal(preview.journal, "Graph Journal");
  assert.equal(preview.issue, "2");
  assert.equal(preview.publisher, "A Publisher");
});

test("broken JSON-LD doesn't stop extraction", () => {
  const { preview } = extractPage(
    page(`<title>Still here</title><script type="application/ld+json">{nope</script>`),
    URL_
  );

  assert.equal(preview.title, "Still here");
});

test("microdata", () => {
  const { preview } = extractPage(
    page("", `<article itemscope itemtype="https://schema.org/ScholarlyArticle">
      <h1 itemprop="headline">Micro paper</h1>
      <span itemprop="author" itemscope><span itemprop="name">Lise Meitner</span></span>
      <time itemprop="datePublished" datetime="1939-02-11">Feb</time></article>`),
    URL_
  );

  assert.equal(preview.title, "Micro paper");
  assert.deepEqual(preview.authors, ["Lise Meitner"]);
  assert.equal(preview.date, "1939-02-11");
});

test("one COinS span describes the page", () => {
  const title =
    "ctx_ver=Z39.88-2004&amp;rft.genre=article&amp;rft.atitle=Coins+paper&amp;rft.jtitle=Coin+Journal&amp;rft.au=Niels+Bohr&amp;rft.date=1913-07&amp;rft.spage=1&amp;rft.epage=25&amp;rft_id=info:doi/10.5555/coins.4";
  const { preview, candidates } = extractPage(page("", `<span class="Z3988" title="${title}"></span>`), URL_);

  assert.equal(preview.title, "Coins paper");
  assert.equal(preview.journal, "Coin Journal");
  assert.equal(preview.pages, "1-25");
  assert.equal(preview.doi, "10.5555/coins.4");
  assert.equal(preview.year, "1913");
  assert.deepEqual(candidates, []);
});

test("several COinS spans become a picker", () => {
  const span = (n: number) =>
    `<span class="Z3988" title="rft.atitle=Paper+${n}&amp;rft_id=info:doi/10.5555/list.${n}"></span>`;
  const { candidates, preview } = extractPage(page("<title>Search results</title>", span(1) + span(2) + span(3)), URL_);

  assert.equal(preview.title, "Search results");
  assert.deepEqual(candidates.map((c) => c.label), ["Paper 1", "Paper 2", "Paper 3"]);
});

test("Open Graph article is a web page", () => {
  const { preview } = extractPage(
    page(`<meta property="og:title" content="News story">
          <meta name="author" content="A Reporter">
          <meta property="article:published_time" content="2024-02-03T10:00:00Z">
          <meta property="og:site_name" content="The News">`),
    URL_
  );

  assert.equal(preview.type, "webpage");
  assert.equal(preview.title, "News story");
  assert.equal(preview.date, "2024-02-03");
  assert.equal(preview.publisher, "The News");
  assert.deepEqual(preview.target, { kind: "url", value: URL_ });
});

test("a page with no metadata still gives a saveable item", () => {
  const { preview, candidates } = extractPage(page("<title>Plain page</title>", "<p>Nothing here.</p>"), `${URL_}#top`);

  assert.equal(preview.title, "Plain page");
  assert.equal(preview.type, "webpage");
  assert.equal(preview.canonicalUrl, URL_);
  assert.deepEqual(candidates, []);
  assert.match(buildBibtex(preview), /^@misc\{web_[0-9a-f]{16},/);
});

test("a page with no title falls back to its URL", () => {
  const { preview } = extractPage(page(""), URL_);
  assert.equal(preview.title, URL_);
});

test("a DOI only in the text is offered, not assumed", () => {
  const { preview, candidates } = extractPage(
    page("<title>Blog post</title>", "<p>See doi:10.5555/text.5.</p><script>var x='10.9999/fromscript';</script>"),
    URL_
  );

  assert.equal(preview.title, "Blog post");
  assert.equal(preview.doi, undefined);
  assert.deepEqual(candidates.map((c) => c.fields.doi), ["10.5555/text.5"]);
});

test("a DOI in the URL identifies the page, and reference lists don't make a picker", () => {
  const { preview, candidates } = extractPage(
    page("<title>Article</title>", '<a href="https://doi.org/10.1111/ref.1">r</a>'),
    "https://publisher.example/doi/full/10.5555/url.6"
  );

  assert.equal(preview.doi, "10.5555/url.6");
  assert.deepEqual(candidates, []);
});

test("arXiv page uses the latest version shown", () => {
  const { preview } = extractPage(
    page(
      `<meta name="citation_title" content="Attention"><meta name="citation_arxiv_id" content="1706.03762">
       <meta name="citation_doi" content="10.5555/arx.7">`,
      `<div id="abs"><div class="dateline">[Submitted on 12 Jun 2017]</div></div>
       <div class="submission-history"><b>[v1]</b> a <b>[v7]</b> b</div>`
    ),
    "https://arxiv.org/abs/1706.03762"
  );

  assert.equal(preview.arxivId, "1706.03762v7");
  assert.equal(preview.date, "2017-06-12");
  assert.deepEqual(preview.target, { kind: "arxiv", value: "1706.03762v7" });
  assert.equal(preview.site, "arxiv.org");
});

test("PDF viewer tab with an identifier in its URL", () => {
  const { preview } = extractFromTab("https://arxiv.org/pdf/2204.12985v4", "2204.12985v4.pdf");
  assert.equal(preview.arxivId, "2204.12985v4");
  assert.deepEqual(preview.target, { kind: "arxiv", value: "2204.12985v4" });
});

test("PDF viewer tab with nothing to go on goes to the backend's resolver", () => {
  const url = "https://files.example/papers/thing.pdf";
  const { preview } = extractFromTab(url, undefined);
  assert.deepEqual(preview.target, { kind: "pdf", value: url });
  assert.equal(preview.title, "thing.pdf");
  assert.equal(preview.pdfUrl, url);
});

test("PDF viewer tab title loses the file name Firefox appends", () => {
  const { preview } = extractFromTab(
    "https://pdf.example/1/main.pdf?X-Amz-Expires=300",
    "The evolving energy values - 1-s2.0-S2666792421000081-main.pdf"
  );
  assert.equal(preview.title, "The evolving energy values");
});

test("about: page still gives an item", () => {
  const { preview } = extractFromTab("about:addons", "Add-ons Manager");
  assert.equal(preview.title, "Add-ons Manager");
  assert.equal(preview.type, "webpage");
});

test("dates", () => {
  assert.deepEqual(normalizeDate("2021-3-5"), { date: "2021-03-05", year: "2021" });
  assert.deepEqual(normalizeDate("12 Jun 2017"), { date: "2017-06-12", year: "2017" });
  assert.deepEqual(normalizeDate("June 12, 2017"), { date: "2017-06-12", year: "2017" });
  assert.deepEqual(normalizeDate("2017-06"), { year: "2017" });
  assert.deepEqual(normalizeDate("2021-02-31"), { year: "2021" });
  assert.deepEqual(normalizeDate("Spring 2019"), { year: "2019" });
  assert.deepEqual(normalizeDate("no date"), {});
});

test("DOI edges", () => {
  assert.deepEqual(findDois("see 10.1000/abc.def, and (10.1000/xyz)."), ["10.1000/abc.def", "10.1000/xyz"]);
  assert.deepEqual(findDois("10.1016/S0022(99)00001-1"), ["10.1016/S0022(99)00001-1"]);
  assert.equal(doiFromUrl("https://x.example/doi/pdf/10.1002/abc.123"), "10.1002/abc.123");
  assert.equal(doiFromUrl("https://x.example/article/10.1002%2Fabc.123/full"), "10.1002/abc.123");
});

test("ISBN checksum", () => {
  assert.equal(parseIsbn("978-3-16-148410-0"), "9783161484100");
  assert.equal(parseIsbn("0-306-40615-2"), "0306406152");
  assert.equal(parseIsbn("978-3-16-148410-1"), undefined);
});

test("Crossref record", () => {
  const fields = parseCrossref({
    message: {
      type: "proceedings-article",
      title: ["A <i>title</i>"],
      author: [{ given: "Ada", family: "Lovelace" }, { name: "A Consortium" }],
      abstract: "<jats:p>Words here.</jats:p>",
      DOI: "10.1/x",
      "container-title": ["Proc."],
      published: { "date-parts": [[2020, 2, 3]] },
    },
  });

  assert.equal(fields.type, "conference");
  assert.deepEqual(fields.authors, ["Ada Lovelace", "A Consortium"]);
  assert.equal(fields.abstract, "Words here.");
  assert.equal(fields.date, "2020-02-03");
});

test("arXiv Atom record", () => {
  const fields = parseArxivAtom(`<feed><entry><id>http://arxiv.org/abs/2204.12985v4</id>
    <published>2022-04-27T18:00:00Z</published><title>Some &amp; title</title>
    <summary>An abstract.</summary><author><name>Ada Lovelace</name></author>
    <arxiv:doi xmlns:arxiv="x">10.1/y</arxiv:doi></entry></feed>`);

  assert.equal(fields.title, "Some & title");
  assert.equal(fields.arxivId, "2204.12985v4");
  assert.equal(fields.date, "2022-04-27");
  assert.equal(fields.doi, "10.1/y");
});

test("PubMed record", () => {
  const fields = parseEsummary(
    { result: { "123": { title: "A study.", authors: [{ name: "Smith J" }], fulljournalname: "J Med", sortpubdate: "2019/05/01 00:00", articleids: [{ idtype: "doi", value: "10.5555/z" }] } } },
    "123"
  );

  assert.equal(fields.title, "A study");
  assert.equal(fields.date, "2019-05-01");
  assert.equal(fields.doi, "10.5555/z");
});

test("lookup falls through to DataCite, and fills only blanks", async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    return url.includes("crossref")
      ? new Response("{}", { status: 404 })
      : new Response(JSON.stringify({ data: { attributes: { titles: [{ title: "Registry title" }], creators: [{ name: "Reg Author" }], publicationYear: 2011, types: { resourceTypeGeneral: "Dataset" } } } }));
  }) as typeof fetch;

  const found = await lookupFields({ doi: "10.5555/d/1" }, fetcher);
  assert.equal(found?.source, "datacite");
  assert.ok(calls[0].includes("10.5555%2Fd%2F1"));

  const { preview } = extractPage(page("<title>Tab title</title>"), "https://x.example/doi/10.5555/d/1");
  const merged = fillBlanks(preview, found!.fields, found!.source);
  assert.equal(merged.title, "Registry title");
  assert.deepEqual(merged.authors, ["Reg Author"]);
  assert.equal(merged.year, "2011");
  assert.equal(merged.sources.title, "datacite");

  const own = fillBlanks({ ...preview, title: "Own title", sources: { title: "highwire" } }, found!.fields, found!.source);
  assert.equal(own.title, "Own title");
});

test("registry replaces a January 1 placeholder and a guessed type, not a real date", () => {
  const base = extractPage(page(`<meta name="citation_title" content="P"><meta name="citation_publication_date" content="2021/01/01">`), URL_).preview;
  const merged = fillBlanks(base, { date: "2021-10-04", year: "2021", type: "dataset" }, "datacite");
  assert.equal(merged.date, "2021-10-04");
  assert.equal(merged.type, "dataset");

  const real = fillBlanks({ ...base, date: "2021-03-15" }, { date: "2021-10-04" }, "crossref");
  assert.equal(real.date, "2021-03-15");

  const otherYear = fillBlanks(base, { date: "2019-10-04" }, "crossref");
  assert.equal(otherYear.date, "2021-01-01");
});

test("JSON-LD headline that is really a description loses to the name", () => {
  const json = JSON.stringify({ "@type": "Article", name: "Real Title", headline: "article published in June" });
  const { preview } = extractPage(page(`<title>Real Title - Wiki</title><script type="application/ld+json">${json}</script>`), URL_);
  assert.equal(preview.title, "Real Title");

  const news = JSON.stringify({ "@type": "NewsArticle", name: "The Site", headline: "Big story" });
  const story = extractPage(page(`<title>Big story | The Site</title><script type="application/ld+json">${news}</script>`), URL_).preview;
  assert.equal(story.title, "Big story");
});

test("BibTeX: an ISBN gives one identity across sites", () => {
  const head = `<meta name="citation_title" content="B"><meta name="citation_isbn" content="978-3-16-148410-0">`;
  const a = extractPage(page(head), "https://a.example/1").preview;
  const b = extractPage(page(head), "https://b.example/2").preview;
  assert.equal(buildBibtex(a).split("\n")[0], "@book{isbn_9783161484100,");
  assert.equal(buildBibtex(b).split("\n")[0], "@book{isbn_9783161484100,");
});

test("arXiv API supplies the version a bare id lacks, and never downgrades", () => {
  const { preview } = extractFromTab("https://arxiv.org/pdf/1706.03762", "1706.03762.pdf");
  const merged = fillBlanks(preview, { arxivId: "1706.03762v7", title: "Attention" }, "arxiv-api");
  assert.equal(merged.arxivId, "1706.03762v7");
  assert.deepEqual(merged.target, { kind: "arxiv", value: "1706.03762v7" });

  const pinned = extractFromTab("https://arxiv.org/pdf/1706.03762v3", undefined).preview;
  assert.equal(fillBlanks(pinned, { arxivId: "1706.03762v7" }, "arxiv-api").arxivId, "1706.03762v3");
});

const crossrefTitled = (title: string) =>
  (async () =>
    new Response(JSON.stringify({ message: { type: "proceedings-article", title: [title], author: [{ given: "Kaiming", family: "He" }], DOI: "10.1109/CVPR.2016.90" } }))) as unknown as typeof fetch;

test("a DOI in the page text whose registry title matches is the page's own", async () => {
  const { preview, candidates } = extractPage(
    page(`<meta property="og:title" content="Deep Residual Learning for Image Recognition | IEEE Xplore">`, "<p>DOI: 10.1109/CVPR.2016.90</p>"),
    "https://ieeexplore.ieee.org/document/7780459"
  );
  assert.equal(preview.type, "webpage");

  const identified = await identifyPage(preview, candidates, crossrefTitled("Deep Residual Learning for Image Recognition"));
  assert.equal(identified?.doi, "10.1109/CVPR.2016.90");
  assert.equal(identified?.type, "conference");
  assert.deepEqual(identified?.authors, ["Kaiming He"]);
  assert.deepEqual(identified?.target, { kind: "doi", value: "10.1109/CVPR.2016.90" });
});

test("a DOI whose registry title differs stays a citation", async () => {
  const { preview, candidates } = extractPage(page("<title>My blog post about papers</title>", "<p>doi:10.5555/cited.1</p>"), URL_);
  assert.equal(await identifyPage(preview, candidates, crossrefTitled("Some other long paper title")), null);
});

test("a list of references or COinS items never identifies the page", async () => {
  const dois = [1, 2, 3, 4].map((n) => `<p>doi:10.5555/ref.${n}</p>`).join("");
  const many = extractPage(page("<title>Same long title here</title>", dois), URL_);
  assert.equal(await identifyPage(many.preview, many.candidates, crossrefTitled("Same long title here")), null);

  const span = (n: number) => `<span class="Z3988" title="rft.atitle=Same+long+title+here&amp;rft_id=info:doi/10.5555/c.${n}"></span>`;
  const wiki = extractPage(page("<title>Same long title here</title>", span(1) + span(2)), URL_);
  assert.equal(await identifyPage(wiki.preview, wiki.candidates, crossrefTitled("Same long title here")), null);
});

/**
 * Waits until the request is aborted, as fetch does with a server that never answers.
 * The timer stands in for the open socket: Node's AbortSignal.timeout doesn't keep
 * the process alive on its own, so without it the test runner exits mid-test.
 */
const hangs = (async (_url: string, init: RequestInit = {}) =>
  new Promise((_, reject) => {
    const socket = setTimeout(() => reject(new Error("never aborted")), 5000);
    init.signal?.addEventListener("abort", () => {
      clearTimeout(socket);
      reject(init.signal?.reason);
    });
  })) as unknown as typeof fetch;

test("identity checks share one time budget", async () => {
  const { preview, candidates } = extractPage(page("<title>Same long title here</title>", "<p>doi:10.5555/a.1</p><p>doi:10.5555/a.2</p>"), URL_);
  assert.equal(candidates.length, 2);

  const started = Date.now();
  assert.equal(await identifyPage(preview, candidates, hangs, 50), null);
  assert.ok(Date.now() - started < 1000, "gave up when the budget ran out");
});

test("identity checks run together, and the first match in page order wins", async () => {
  const { preview, candidates } = extractPage(page("<title>Same long title here</title>", "<p>doi:10.5555/a.1</p><p>doi:10.5555/a.2</p>"), URL_);
  const finished: string[] = [];
  const fetcher = (async (url: string) => {
    const doi = decodeURIComponent(url.split("/works/")[1] ?? "");
    // The first DOI answers last.
    await new Promise((resolve) => setTimeout(resolve, doi.endsWith(".1") ? 40 : 0));
    finished.push(doi);
    return new Response(JSON.stringify({ message: { title: ["Same long title here"], DOI: doi } }));
  }) as unknown as typeof fetch;

  const identified = await identifyPage(preview, candidates, fetcher);
  assert.equal(identified?.doi, "10.5555/a.1");
  // One after another, the second couldn't finish first.
  assert.deepEqual(finished, ["10.5555/a.2", "10.5555/a.1"]);
});

test("a save collects the ticked page and items, in order", async () => {
  const { preview, candidates } = extractPage(page("<title>Reading list page</title>", "<p>doi:10.5555/a.1</p><p>doi:10.5555/a.2</p>"), URL_);
  const [first, second] = candidates;
  const enrich = async (item: typeof preview) => ({ ...item, journal: "Looked up" });

  const all = await collectPreviews(preview, candidates, new Set(["page", first.id, second.id]), "page", enrich);
  assert.deepEqual(all.map((item) => item.doi), [preview.doi, first.fields.doi, second.fields.doi]);
  assert.equal(all[0], preview, "the page itself isn't looked up again");
  assert.equal(all[1].journal, "Looked up");

  const itemsOnly = await collectPreviews(preview, candidates, new Set([second.id]), "page", enrich);
  assert.deepEqual(itemsOnly.map((item) => item.doi), [second.fields.doi]);
});

test("a failed lookup rejects the save, so the popup can show it", async () => {
  const { preview, candidates } = extractPage(page("<title>Reading list page</title>", "<p>doi:10.5555/a.1</p>"), URL_);
  const broken = async () => {
    throw new Error("lookup broke");
  };

  await assert.rejects(collectPreviews(preview, candidates, new Set(["page", candidates[0].id]), "page", broken), /lookup broke/);
});

test("author display and abstract labels", () => {
  assert.equal(displayName("Vaswani, Ashish"), "Ashish Vaswani");
  assert.equal(displayName("Ashish Vaswani"), "Ashish Vaswani");
  assert.equal(displayName("A, B, C"), "A, B, C");

  const summary = (text: string) =>
    extractPage(page(`<meta name="citation_title" content="T"><meta name="citation_abstract" content="${text}">`), URL_).preview.abstract;
  assert.equal(summary("Summary Whether the effects hold"), "Whether the effects hold");
  assert.equal(summary("Abstract: We show this"), "We show this");
  assert.equal(summary("Summary statistics are useful"), "Summary statistics are useful");
});

test("a failed lookup adds nothing", async () => {
  const fetcher = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;

  assert.equal(await lookupFields({ doi: "10.1/x" }, fetcher), null);
  assert.equal(await lookupFields({}, fetcher), null);
});

test("BibTeX: arXiv key, version, escaping, verbatim URLs", () => {
  const { preview } = extractPage(
    page(`<meta name="citation_title" content="50% of A_B #1 {x}"><meta name="citation_arxiv_id" content="1706.03762v2">
          <meta name="citation_doi" content="10.5555/a_b"><meta name="citation_journal_title" content="R&amp;D">`),
    "https://arxiv.org/abs/1706.03762v2"
  );
  const bib = buildBibtex(preview);

  assert.match(bib, /^@article\{arxiv:1706_03762,/);
  assert.match(bib, /title = \{50\\% of A\\_B \\#1 \\\{x\\\}\}/);
  assert.match(bib, /eprint = \{1706\.03762v2\}/);
  assert.match(bib, /doi = \{10\.5555\/a_b\}/);
  assert.match(bib, /journal = \{R\\&D\}/);
});

test("BibTeX: same URL same key, entry types", () => {
  const a = extractPage(page("<title>a</title>"), URL_).preview;
  const b = extractPage(page("<title>b</title>"), `${URL_}#frag`).preview;
  assert.equal(buildBibtex(a).split("\n")[0], buildBibtex(b).split("\n")[0]);

  const book = extractPage(page(`<meta name="citation_title" content="B"><meta name="citation_isbn" content="978-3-16-148410-0">`), URL_).preview;
  assert.equal(book.type, "book");
  assert.match(buildBibtex(book), /^@book\{/);
});
