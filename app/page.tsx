import type { Metadata } from "next";
import Scribble from "./Scribble";

export const metadata: Metadata = {
  title: "Follow the line",
  description: "A quiet drawing prompt.",
};

export default function Home() {
  return <Scribble />;
}
