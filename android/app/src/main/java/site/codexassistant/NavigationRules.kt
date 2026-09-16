package site.codexassistant

internal fun parentPage(page: String): String = if (page == "settings") "tasks" else "settings"

internal fun showPrimaryNavigation(
    page: String,
    selectedId: String?,
    keyboardOpen: Boolean,
): Boolean = selectedId == null && page in setOf("tasks", "settings") && !keyboardOpen
