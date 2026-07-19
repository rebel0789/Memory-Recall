final class ItemService: ItemLoading {
    func find(id: String) -> Item {
        Item(id: id)
    }
}

extension ItemService {
    func summary(item: Item) -> String {
        item.id
    }
}

func describe(service: ItemService, item: Item) -> String {
    service.summary(item: item)
}
