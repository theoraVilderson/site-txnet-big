
export function initTheme() {
    const storedTheme = localStorage.getItem("theme"); // چک کردن تم ذخیره شده
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  
    if (storedTheme === "dark") {
      document.body.classList.add("dark");
    } else if (storedTheme === "light") {
      document.body.classList.remove("dark");
    } else if (prefersDark) {
      document.body.classList.add("dark");
    } else {
      document.body.classList.remove("dark");
    }
  }
  
  export function toggleTheme() {
    if (document.body.classList.contains("dark")) {
      document.body.classList.remove("dark");
      localStorage.setItem("theme", "light");
    } else {
      document.body.classList.add("dark");
      localStorage.setItem("theme", "dark");
    }
  }
  