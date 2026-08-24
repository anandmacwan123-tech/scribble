import type { Metadata } from "next";
import Gallery from "./Gallery";

export const metadata: Metadata = {
  title: "Kept",
  description: "Saved drawings.",
};

export default function GalleryPage() {
  return <Gallery />;
}
