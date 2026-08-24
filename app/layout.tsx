import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Draw a 5",
  description: "Draw and keep an A4 page of fives.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
