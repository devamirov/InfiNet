<?php
/**
 * Admin dashboard – only shown when session is set by index.php. Does not touch any other backend.
 */
session_start();
if (empty($_SESSION['admin_authenticated'])) {
    header('Location: index.php');
    exit;
}
// Serve dashboard content (no password in it)
$dashboard_file = __DIR__ . '/dashboard-content.html';
if (is_file($dashboard_file) && is_readable($dashboard_file)) {
    readfile($dashboard_file);
} else {
    header('HTTP/1.1 500 Internal Server Error');
    echo 'Dashboard file not found.';
}
