import { createRoot } from "react-dom/client";
import "./bar.css";
import { Bar } from "./Bar";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<Bar />);
}
