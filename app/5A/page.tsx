import type { Metadata } from "next";
import Animator from "./Animator";

export const metadata: Metadata = {
  title: "5A — Animation",
  description: "Animate the kept fives.",
};

export default function AnimationPage() {
  return <Animator />;
}
