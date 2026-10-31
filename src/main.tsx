import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import App from "./App";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
