<?php
/**
 * Admin login gate – password from .admin_secret (parent dir) or env ADMIN_PASSWORD.
 * No password in HTML/JS. Does not touch any other backend.
 */
session_start();

$parent = dirname(__DIR__);
$secret_file = $parent . '/.admin_secret';
if (function_exists('getenv') && getenv('ADMIN_PASSWORD') !== false) {
    $correct_password = getenv('ADMIN_PASSWORD');
} elseif (is_file($secret_file) && is_readable($secret_file)) {
    $correct_password = trim(file_get_contents($secret_file));
} else {
    $correct_password = '';
}

// Already logged in → show dashboard
if (!empty($_SESSION['admin_authenticated'])) {
    header('Location: dashboard.php');
    exit;
}

$error = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['password'])) {
    if ($correct_password !== '' && $_POST['password'] === $correct_password) {
        $_SESSION['admin_authenticated'] = true;
        header('Location: dashboard.php');
        exit;
    }
    $error = 'Incorrect password. Please try again.';
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>InfiNet Admin – Login</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #060097 0%, #57ffff 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .box { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); max-width: 400px; width: 100%; }
        h2 { color: #060097; margin-bottom: 8px; text-align: center; }
        p.sub { color: #666; text-align: center; margin-bottom: 24px; font-size: 14px; }
        input[type="password"] { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 16px; margin-bottom: 12px; box-sizing: border-box; }
        .error { color: #d32f2f; font-size: 14px; margin-bottom: 12px; text-align: center; min-height: 20px; }
        button { width: 100%; padding: 12px; background: linear-gradient(135deg, #060097 0%, #57ffff 100%); color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; }
        button:hover { opacity: 0.95; }
        p.hint { text-align: center; margin-top: 16px; font-size: 12px; color: #999; }
    </style>
</head>
<body>
    <div class="box">
        <h2>InfiNet Admin Panel</h2>
        <p class="sub">Enter password to access</p>
        <?php if ($error): ?><p class="error"><?= htmlspecialchars($error) ?></p><?php endif; ?>
        <form method="post">
            <input type="password" name="password" placeholder="Password" required autofocus>
            <button type="submit">Login</button>
        </form>
        <p class="hint">Press Enter to submit</p>
    </div>
</body>
</html>
