struct Item {
    let id: String
}

protocol ItemLoading {
    func find(id: String) -> Item
}
