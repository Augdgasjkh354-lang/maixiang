import { mountGame } from "./ui/app.js";

const root = document.getElementById("app");
if (!root) throw new Error("缺少游戏页面根容器 #app");
mountGame(root);
