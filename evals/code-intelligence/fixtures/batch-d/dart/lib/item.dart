library demo.item;

class Item {
  const Item(this.id);
  final String id;
}

abstract interface class ItemLoader {
  Item find(String id);
}

mixin ItemLogging {
  String label(Item item) => item.id;
}

class ItemService with ItemLogging implements ItemLoader {
  @override
  Item find(String id) => Item(id);
}

extension ItemSummary on Item {
  String summary() => id;
}

String describe(Item item) => item.summary();
