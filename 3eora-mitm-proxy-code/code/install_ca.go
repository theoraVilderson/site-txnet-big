package main

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

func installCACert(certPEM []byte) {
	switch runtime.GOOS {
	case "linux":
		installLinux(certPEM)
	case "darwin":
		installMacOS(certPEM)
	case "windows":
		installWindows(certPEM)
	default:
		fmt.Println("Unsupported OS for automatic CA install. Please install ca.crt manually.")
	}
}

func installLinux(certPEM []byte) {
	target := "/usr/local/share/ca-certificates/3eora-mitm-proxy-ca.crt"
	if err := os.WriteFile(target, certPEM, 0644); err != nil {
		fmt.Println("⛔ Cannot write CA (need root?). Run manually:")
		fmt.Println("  sudo cp ca.crt /usr/local/share/ca-certificates/3eora-mitm-proxy-ca.crt")
		fmt.Println("  sudo update-ca-certificates")
		return
	}
	cmd := exec.Command("update-ca-certificates")
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Printf("update-ca-certificates failed: %v\n%s\n", err, out)
		fmt.Println("Run 'sudo update-ca-certificates' manually.")
	} else {
		fmt.Println("✅ CA installed successfully (Linux)")
	}
}

func installMacOS(certPEM []byte) {
	f, err := os.CreateTemp("", "3eora-mitm-proxy-ca-*.crt")
	if err != nil {
		fmt.Println("Failed to create temp file:", err)
		return
	}
	defer os.Remove(f.Name())
	f.Write(certPEM)
	f.Close()

	cmd := exec.Command("security", "add-trusted-cert", "-d", "-r", "trustRoot",
		"-k", "/Library/Keychains/System.keychain", f.Name())
	if out, err := cmd.CombinedOutput(); err != nil {
		fmt.Printf("Failed to install CA on macOS: %v\n%s\n", err, out)
		fmt.Println("Run manually: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.crt")
	} else {
		fmt.Println("✅ CA installed successfully (macOS)")
	}
}

// installWindows adds the CA to the current user's "Root" trust store via
// certutil. Running the proxy from an elevated (Administrator) prompt installs
// it machine-wide; a non-elevated prompt still succeeds for the current user,
// which is enough for most dev tools (Node, Docker Desktop's WSL2 backend, etc).
func installWindows(certPEM []byte) {
	if _, err := exec.LookPath("certutil"); err != nil {
		fmt.Println("⛔ certutil not found on PATH. Install the CA manually:")
		fmt.Println("  certutil -addstore -user Root ca.crt")
		return
	}

	f, err := os.CreateTemp("", "3eora-mitm-proxy-ca-*.crt")
	if err != nil {
		fmt.Println("Failed to create temp file:", err)
		return
	}
	defer os.Remove(f.Name())
	f.Write(certPEM)
	f.Close()

	// Try machine-wide store first (requires an elevated/Administrator prompt).
	cmd := exec.Command("certutil", "-addstore", "Root", f.Name())
	if out, err := cmd.CombinedOutput(); err != nil {
		// Fall back to the per-user store, which doesn't require elevation.
		cmdUser := exec.Command("certutil", "-addstore", "-user", "Root", f.Name())
		if outUser, errUser := cmdUser.CombinedOutput(); errUser != nil {
			fmt.Printf("Failed to install CA on Windows: %v\n%s\n%s\n", err, out, outUser)
			fmt.Println("Run manually as Administrator: certutil -addstore Root ca.crt")
			fmt.Println("Or without admin rights:        certutil -addstore -user Root ca.crt")
		} else {
			fmt.Println("✅ CA installed successfully (Windows, current user)")
		}
	} else {
		fmt.Println("✅ CA installed successfully (Windows, machine-wide)")
	}
}