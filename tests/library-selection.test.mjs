import assert from "node:assert/strict";
import test from "node:test";

import {
  getLayerSourceKey,
  getLibraryPreviewUrl,
} from "../app/5A/library.ts";

function drawing(crop = null) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    updatedAt: "2026-08-26T09:00:00.000Z",
    previewUrl:
      "/api/drawings/11111111-1111-4111-8111-111111111111.svg?preview=1",
    crop,
  };
}

const firstCrop = {
  x: 74.375,
  y: 105.25,
  width: 446.25,
  height: 631.5,
  revision: 3,
  updatedAt: "2026-08-26T09:01:00.000Z",
};

test("default and uncropped 5E libraries share the identity source", () => {
  const cropped = drawing(firstCrop);
  const uncropped = drawing();

  assert.equal(
    getLayerSourceKey(cropped, "default"),
    getLayerSourceKey(uncropped, "edited"),
  );
  assert.match(getLayerSourceKey(cropped, "default"), /:identity$/);
});

test("5E source keys change for crop revisions and geometry", () => {
  const initial = getLayerSourceKey(drawing(firstCrop), "edited");
  const revised = getLayerSourceKey(
    drawing({ ...firstCrop, revision: 4 }),
    "edited",
  );
  const moved = getLayerSourceKey(
    drawing({ ...firstCrop, x: firstCrop.x + 1 }),
    "edited",
  );

  assert.notEqual(initial, revised);
  assert.notEqual(initial, moved);
  assert.match(initial, /:5E:3:/);
});

test("only a cropped 5E preview requests the crop variant", () => {
  const defaultUrl = new URL(
    getLibraryPreviewUrl(drawing(firstCrop), "default", "https://example.com"),
  );
  const editedUrl = new URL(
    getLibraryPreviewUrl(drawing(firstCrop), "edited", "https://example.com"),
  );
  const identityUrl = new URL(
    getLibraryPreviewUrl(drawing(), "edited", "https://example.com"),
  );

  assert.equal(defaultUrl.searchParams.has("crop"), false);
  assert.equal(identityUrl.searchParams.has("crop"), false);
  assert.equal(editedUrl.searchParams.get("crop"), "1");
  assert.match(editedUrl.searchParams.get("v") ?? "", /:5E:3:/);
});
