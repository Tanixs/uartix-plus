import React from "react";
import ReactDOM from "react-dom/client";
import "dockview-react/dist/styles/dockview.css";
import "./styles/theme.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
