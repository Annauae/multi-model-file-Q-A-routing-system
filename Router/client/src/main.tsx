import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";


// 渲染 App 组件到根元素
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
