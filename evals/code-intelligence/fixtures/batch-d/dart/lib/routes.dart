library demo.routes;

import 'package:shelf_router/shelf_router.dart';
import 'item.dart';
export 'item.dart' show Item;
part 'routes_part.dart';

Router buildRouter(ItemService service) {
  final router = Router();
  router.get('/items/<id>', (request, String id) => service.find(id).id);
  return router;
}
