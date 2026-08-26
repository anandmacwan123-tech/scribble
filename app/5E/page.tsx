import type { Metadata } from "next";
import CropEditor from "./CropEditor";

export const metadata: Metadata = {
  title: "5E — Crop editor",
  description: "Edit the A4 crops used by the animation tool.",
};

export default function CropEditorPage() {
  return <CropEditor />;
}
