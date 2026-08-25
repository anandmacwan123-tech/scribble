import type { Metadata } from "next";
import Scribble from "./Scribble";

export const metadata: Metadata = {
  title: "Draw a 5",
  description: "Draw and keep an A4 page of fives.",
};

export default function Home() {
  return <Scribble />;
}
