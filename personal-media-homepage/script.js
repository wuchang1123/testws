const root = document.documentElement;
const toggleBtn = document.getElementById("themeToggle");
const themeStorageKey = "personal-site-theme";

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  toggleBtn.textContent = theme === "dark" ? "浅色模式" : "深色模式";
}

const savedTheme = localStorage.getItem(themeStorageKey);
if (savedTheme === "dark" || savedTheme === "light") {
  applyTheme(savedTheme);
} else {
  applyTheme("light");
}

toggleBtn.addEventListener("click", () => {
  const nextTheme = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem(themeStorageKey, nextTheme);
  applyTheme(nextTheme);
});
