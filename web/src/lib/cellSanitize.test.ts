// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Vitaliy Bondar

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeCellHtml } from "./cellSanitize";

describe("sanitizeCellHtml (web render boundary)", () => {
  it("strips script/style/iframe/object and comments", () => {
    assert.equal(sanitizeCellHtml("<script>alert(1)</script>ok"), "ok");
    assert.equal(sanitizeCellHtml("<style>*{}</style>ok"), "ok");
    assert.equal(sanitizeCellHtml("<iframe src=//x></iframe>ok"), "ok");
    assert.equal(sanitizeCellHtml("<object data=//x></object>ok"), "ok");
    assert.equal(sanitizeCellHtml("a<!-- c -->b"), "ab");
  });

  it("drops event handlers and unknown tags", () => {
    assert.equal(sanitizeCellHtml('<p onclick="alert(1)">x</p>'), "<p>x</p>");
    assert.equal(sanitizeCellHtml("<video src=//x></video>"), "");
  });

  it("drops javascript: hrefs including entity/whitespace encodings", () => {
    assert.equal(sanitizeCellHtml('<a href="javascript:alert(1)">x</a>'), '<a target="_blank" rel="noopener noreferrer">x</a>');
    assert.equal(sanitizeCellHtml('<a href="&#106;avascript:alert(1)">x</a>'), '<a target="_blank" rel="noopener noreferrer">x</a>');
    assert.equal(sanitizeCellHtml('<a href="jav\tascript:alert(1)">x</a>'), '<a target="_blank" rel="noopener noreferrer">x</a>');
    assert.equal(sanitizeCellHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'), '<a target="_blank" rel="noopener noreferrer">x</a>');
  });

  it("keeps safe links, images and relative references", () => {
    assert.equal(
      sanitizeCellHtml('<a href="https://example.com">x</a>'),
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>'
    );
    assert.equal(
      sanitizeCellHtml('<a href="/files/output/a.png">x</a>'),
      '<a href="/files/output/a.png" target="_blank" rel="noopener noreferrer">x</a>'
    );
    assert.equal(
      sanitizeCellHtml('<img src="https://example.com/a.png" alt="a">'),
      '<img src="https://example.com/a.png" alt="a">'
    );
    assert.equal(
      sanitizeCellHtml('<img src="data:image/png;base64,AAA" alt="a">'),
      '<img src="data:image/png;base64,AAA" alt="a">'
    );
  });

  it("filters CSS url()/@import exfil from style attributes", () => {
    assert.equal(sanitizeCellHtml('<div style="background:url(//x/a.gif);color:red">x</div>'), '<div style="color:red">x</div>');
    assert.equal(sanitizeCellHtml('<div style="@import url(//x)">x</div>'), '<div>x</div>');
    assert.equal(sanitizeCellHtml('<span style="color:red">x</span>'), '<span style="color:red">x</span>');
  });

  it("is idempotent on sanitizer output", () => {
    const once = sanitizeCellHtml('<a href="https://example.com">x</a><p style="color:red">y</p>');
    assert.equal(sanitizeCellHtml(once), once);
  });
});
