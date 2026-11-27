if (window.opener) {
  window.opener.postMessage({ quothAuthRedirect: window.location.href }, window.location.origin)
  window.close()
}
